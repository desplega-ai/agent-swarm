import type { Client } from "@libsql/client";

/**
 * Live models.dev catalog with a committed snapshot as the final fallback.
 *
 * Read path (`getCatalog`) never touches the network: it returns the newest
 * payload held in memory, else the committed snapshot. The server keeps the
 * in-memory copy fresh (`startCatalogRefresh`): on boot it loads the last good
 * payload from `model_catalog_cache`, then revalidates against models.dev every
 * 6h with `If-None-Match`. A failed fetch keeps the previous payload, so the
 * catalog only ever moves forward to a validated payload.
 */

import type { ModelsDevCatalog, ModelsDevModel } from "@desplega/model-catalog";

export type {
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevSection,
} from "@desplega/model-catalog";

export type CatalogSource = "live" | "db" | "snapshot";

export interface CatalogState {
  catalog: ModelsDevCatalog;
  source: CatalogSource;
  fetchedAt: string | null;
  etag: string | null;
}

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
/** Sections the evals app reads; a payload missing any of them is rejected. */
const REQUIRED_SECTIONS = ["anthropic", "openai", "openrouter"] as const;

let current: CatalogState | null = null;
let snapshotPromise: Promise<CatalogState> | null = null;
let version = 0;

function loadSnapshot(): Promise<CatalogState> {
  snapshotPromise ??= (async () => {
    const url = new URL("../../../../src/be/modelsdev-cache.json", import.meta.url);
    const catalog = (await Bun.file(url).json()) as ModelsDevCatalog;
    return { catalog, source: "snapshot", fetchedAt: null, etag: null } satisfies CatalogState;
  })();
  return snapshotPromise;
}

/**
 * The committed snapshot, regardless of any live payload. It is the reviewed
 * allowlist of selectable model IDs: live refreshes may update pricing and
 * metadata but never add a model to the picker.
 */
export async function getSnapshotCatalog(): Promise<ModelsDevCatalog> {
  return (await loadSnapshot()).catalog;
}

/**
 * The catalog that model aliases resolve against: every section keeps only the
 * committed snapshot's IDs (the reviewed allowlist), with live metadata such as
 * `release_date` layered over each one. An alias therefore never selects a
 * model the picker would refuse.
 */
export async function getResolutionCatalog(): Promise<ModelsDevCatalog> {
  const snapshot = await getSnapshotCatalog();
  const live = (await getCatalog()).catalog;
  const out: ModelsDevCatalog = {};
  for (const [key, section] of Object.entries(snapshot)) {
    const liveModels = live[key]?.models ?? {};
    const models: Record<string, ModelsDevModel> = {};
    for (const [id, m] of Object.entries(section.models)) models[id] = liveModels[id] ?? m;
    out[key] = { ...section, models };
  }
  return out;
}

/** Current catalog: newest live/DB payload in memory, else the committed snapshot. */
export async function getCatalog(): Promise<CatalogState> {
  return current ?? (await loadSnapshot());
}

/** Bumps whenever the in-memory catalog changes; lets callers invalidate derived caches. */
export function getCatalogVersion(): number {
  return version;
}

function setCurrent(state: CatalogState): void {
  current = state;
  version++;
}

/** Upper bound on the models.dev body; the real payload is ~9 MB. */
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= MAX_TEXT_LENGTH ? v : undefined;
}

function sanitizeModel(raw: unknown): ModelsDevModel | null {
  if (!isRecord(raw)) return null;
  const model: ModelsDevModel = {};
  const name = text(raw.name);
  if (name !== undefined) model.name = name;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (typeof raw.tool_call === "boolean") model.tool_call = raw.tool_call;
  const release = text(raw.release_date);
  if (release !== undefined) model.release_date = release;
  if (isRecord(raw.limit)) {
    const context = num(raw.limit.context);
    if (context !== undefined) model.limit = { context };
  }
  if (isRecord(raw.cost)) {
    const cost: NonNullable<ModelsDevModel["cost"]> = {};
    for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
      const value = num(raw.cost[key]);
      if (value !== undefined) cost[key] = value;
    }
    model.cost = cost;
  }
  return model;
}

/**
 * Rebuild an untrusted payload into a catalog holding only the sections and
 * fields the evals app reads. Returns null when a required section is missing
 * or has no usable models. Unknown fields and malformed entries are dropped.
 */
export function sanitizeCatalog(payload: unknown): ModelsDevCatalog | null {
  if (!isRecord(payload)) return null;
  const out: ModelsDevCatalog = {};
  for (const key of REQUIRED_SECTIONS) {
    const section = payload[key];
    if (!isRecord(section) || !isRecord(section.models)) return null;
    const models: Record<string, ModelsDevModel> = {};
    for (const [id, raw] of Object.entries(section.models)) {
      if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) continue;
      const model = sanitizeModel(raw);
      if (model) models[id] = model;
    }
    if (Object.keys(models).length === 0) return null;
    out[key] = { id: key, name: text(section.name) ?? key, models };
  }
  return out;
}

export function isValidCatalog(payload: unknown): payload is ModelsDevCatalog {
  return sanitizeCatalog(payload) !== null;
}

async function readBounded(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Load the last good payload persisted in Turso. Returns false when absent or unusable. */
export async function loadCatalogFromDb(db: Client): Promise<boolean> {
  const res = await db.execute(
    "SELECT fetched_at, etag, payload FROM model_catalog_cache WHERE id = 1",
  );
  const row = res.rows[0];
  if (!row) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload));
  } catch {
    return false;
  }
  const catalog = sanitizeCatalog(payload);
  if (!catalog) return false;
  // Never replace a newer in-memory live payload with an older DB copy.
  if (current && current.source === "live") return true;
  setCurrent({
    catalog,
    source: "db",
    fetchedAt: String(row.fetched_at),
    etag: row.etag == null ? null : String(row.etag),
  });
  return true;
}

export type RefreshResult =
  | { status: "updated"; fetchedAt: string; modelCount: number }
  | { status: "not-modified"; fetchedAt: string }
  | { status: "error"; error: string };

export interface RefreshOptions {
  db?: Client | null;
  fetchImpl?: typeof fetch;
  url?: string;
  now?: () => Date;
}

function countModels(catalog: ModelsDevCatalog): number {
  return REQUIRED_SECTIONS.reduce(
    (n, key) => n + Object.keys(catalog[key]?.models ?? {}).length,
    0,
  );
}

/**
 * Fetch models.dev once. 200 → validate, swap in, persist. 304 → keep the
 * payload, bump its timestamp. Any failure leaves the current catalog untouched.
 */
export async function refreshCatalog(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const headers: Record<string, string> = { accept: "application/json" };
  const etag = current && current.source !== "snapshot" ? current.etag : null;
  if (etag) headers["if-none-match"] = etag;
  try {
    const res = await fetchImpl(opts.url ?? MODELS_DEV_URL, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 304 && current) {
      setCurrent({ ...current, fetchedAt: now });
      await opts.db?.execute({
        sql: "UPDATE model_catalog_cache SET fetched_at = ? WHERE id = 1",
        args: [now],
      });
      return { status: "not-modified", fetchedAt: now };
    }
    if (!res.ok) return { status: "error", error: `models.dev responded ${res.status}` };
    const body = await readBounded(res);
    if (body === null) {
      return { status: "error", error: `models.dev payload exceeds ${MAX_CATALOG_BYTES} bytes` };
    }
    const payload = sanitizeCatalog(JSON.parse(body));
    if (!payload) {
      return { status: "error", error: "models.dev payload failed validation" };
    }
    const newEtag = text(res.headers.get("etag"));
    const stored = JSON.stringify(payload);
    setCurrent({ catalog: payload, source: "live", fetchedAt: now, etag: newEtag ?? null });
    await opts.db?.execute({
      sql: `INSERT INTO model_catalog_cache (id, fetched_at, etag, payload) VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at,
              etag = excluded.etag, payload = excluded.payload`,
      args: [now, newEtag ?? null, stored],
    });
    return { status: "updated", fetchedAt: now, modelCount: countModels(payload) };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function isStale(state: CatalogState | null, nowMs: number): boolean {
  if (!state?.fetchedAt) return true;
  return nowMs - Date.parse(state.fetchedAt) >= CATALOG_TTL_MS;
}

/**
 * Server boot hook: load the persisted payload, refresh if stale, then
 * revalidate every 6h. Errors are logged, never thrown; the snapshot stays the
 * floor. Returns a stop function.
 */
export async function startCatalogRefresh(db: Client): Promise<() => void> {
  const log = (r: RefreshResult) => {
    if (r.status === "error") console.warn(`[model-catalog] refresh failed: ${r.error}`);
    else if (r.status === "updated") console.log(`[model-catalog] loaded ${r.modelCount} models`);
  };
  try {
    await loadCatalogFromDb(db);
  } catch (err) {
    console.warn(`[model-catalog] could not read cache: ${String(err)}`);
  }
  if (isStale(current, Date.now())) void refreshCatalog({ db }).then(log);
  const timer = setInterval(() => void refreshCatalog({ db }).then(log), CATALOG_TTL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Test-only: forget the in-memory payload so the snapshot is served again. */
export function resetCatalogForTests(): void {
  current = null;
  version++;
}
