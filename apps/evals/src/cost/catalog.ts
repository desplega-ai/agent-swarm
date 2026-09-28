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

export interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevSection {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevSection>;

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

export function isValidCatalog(payload: unknown): payload is ModelsDevCatalog {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;
  return REQUIRED_SECTIONS.every((key) => {
    const section = obj[key] as { models?: unknown } | undefined;
    return (
      !!section &&
      typeof section === "object" &&
      !!section.models &&
      typeof section.models === "object" &&
      Object.keys(section.models).length > 0
    );
  });
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
  if (!isValidCatalog(payload)) return false;
  // Never replace a newer in-memory live payload with an older DB copy.
  if (current && current.source === "live") return true;
  setCurrent({
    catalog: payload,
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
    const text = await res.text();
    const payload: unknown = JSON.parse(text);
    if (!isValidCatalog(payload)) {
      return { status: "error", error: "models.dev payload failed validation" };
    }
    const newEtag = res.headers.get("etag");
    setCurrent({ catalog: payload, source: "live", fetchedAt: now, etag: newEtag });
    await opts.db?.execute({
      sql: `INSERT INTO model_catalog_cache (id, fetched_at, etag, payload) VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at,
              etag = excluded.etag, payload = excluded.payload`,
      args: [now, newEtag, text],
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
