/**
 * Persistent model catalog (migration 168).
 *
 * - `model_catalog`: models.dev rows for CATALOG_PROVIDER_IDS, rewritten on
 *   every full fetch by `src/be/pricing-refresh.ts`.
 * - `model_catalog_overlay`: hand-verified facts (overlay wins per non-null
 *   field; overlay-only models are served too). Rows flagged
 *   `expiresWhenUpstreamMatches` are deleted once upstream agrees.
 * - `model_catalog_meta`: single-row ETag / Last-Modified / fetch times.
 *
 * The in-memory projection in `src/be/models-catalog.ts` is rebuilt from here
 * by `reloadModelsCatalog()` and invalidated on every refresh / overlay write.
 * See runbooks/model-catalog.md.
 */
import {
  getActivePricingRow,
  getDbClient,
  type InsertPricingRowInput,
  insertPricingRow,
} from "./db";
import {
  CATALOG_PROVIDER_IDS,
  type CatalogModel,
  type CatalogProviderId,
  type CatalogReasoningOption,
  getModelsCatalog,
  invalidateModelsCatalog,
  type ModelsCatalog,
  type ModelsCatalogResult,
  setLiveModelsCatalog,
  setSnapshotOverlayCatalog,
  snapshotModelsCatalog,
} from "./models-catalog";
import type { ModelsDevCache } from "./modelsdev-cache";
import { buildModelsDevSeedRows } from "./seed-pricing";

export interface ModelCatalogPricing {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

/** Fact columns shared by the upstream table and the overlay. */
export interface ModelCatalogFacts {
  name?: string | null;
  family?: string | null;
  releaseDate?: string | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  reasoning?: boolean | null;
  reasoningOptions?: CatalogReasoningOption[] | null;
  pricing?: ModelCatalogPricing | null;
  status?: string | null;
}

export interface ModelCatalogEntry extends ModelCatalogFacts {
  provider: string;
  modelId: string;
  providerName?: string | null;
  checkedAt: number;
}

export interface ModelCatalogOverlayInput extends ModelCatalogFacts {
  provider: string;
  modelId: string;
  reason: string;
  verifiedBy?: string | null;
  expiresWhenUpstreamMatches?: boolean;
}

export interface ModelCatalogOverlayEntry extends ModelCatalogOverlayInput {
  expiresWhenUpstreamMatches: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelCatalogMeta {
  etag: string | null;
  lastModified: string | null;
  lastFetchAt: number | null;
  lastCheckedAt: number | null;
}

interface FactRow {
  provider: string;
  modelId: string;
  name: string | null;
  family: string | null;
  releaseDate: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  reasoning: number | null;
  reasoningOptions: string | null;
  pricing: string | null;
  status: string | null;
}

interface CatalogRow extends FactRow {
  providerName: string | null;
  checkedAt: number;
}

interface OverlayRow extends FactRow {
  reason: string;
  verifiedBy: string | null;
  expiresWhenUpstreamMatches: number;
  createdAt: number;
  updatedAt: number;
}

const FACT_KEYS = [
  "name",
  "family",
  "releaseDate",
  "contextWindow",
  "maxOutput",
  "reasoning",
  "reasoningOptions",
  "pricing",
  "status",
] as const;

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function rowToFacts(row: FactRow): ModelCatalogFacts {
  return {
    name: row.name,
    family: row.family,
    releaseDate: row.releaseDate,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    reasoning: row.reasoning === null ? null : row.reasoning === 1,
    reasoningOptions: parseJson<CatalogReasoningOption[]>(row.reasoningOptions),
    pricing: parseJson<ModelCatalogPricing>(row.pricing),
    status: row.status,
  };
}

function factParams(facts: ModelCatalogFacts): (string | number | null)[] {
  return [
    facts.name ?? null,
    facts.family ?? null,
    facts.releaseDate ?? null,
    facts.contextWindow ?? null,
    facts.maxOutput ?? null,
    facts.reasoning === undefined || facts.reasoning === null ? null : facts.reasoning ? 1 : 0,
    facts.reasoningOptions ? JSON.stringify(facts.reasoningOptions) : null,
    facts.pricing ? JSON.stringify(facts.pricing) : null,
    facts.status ?? null,
  ];
}

// ─── models.dev projection ───────────────────────────────────────────────────

/** Loose view of a raw models.dev model — fields beyond the typed cache subset. */
interface RawModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  status?: string;
  reasoning?: boolean;
  reasoning_options?: { type?: unknown; values?: unknown }[];
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Project a models.dev payload into `model_catalog` rows for CATALOG_PROVIDER_IDS. */
export function buildCatalogEntries(cache: ModelsDevCache, checkedAt: number): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const providerId of CATALOG_PROVIDER_IDS) {
    const provider = cache[providerId];
    if (!provider?.models) continue;
    for (const [modelKey, rawModel] of Object.entries(provider.models)) {
      const model = rawModel as RawModelsDevModel;
      const reasoningOptions = Array.isArray(model.reasoning_options)
        ? model.reasoning_options
            .filter((o): o is { type: string; values?: unknown } => typeof o?.type === "string")
            .map((o) => ({
              type: o.type,
              ...(Array.isArray(o.values) ? { values: o.values as string[] } : {}),
            }))
        : [];
      const pricing: ModelCatalogPricing = {};
      for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
        const value = pickNumber(model.cost?.[key]);
        if (value !== undefined) pricing[key] = value;
      }
      entries.push({
        provider: providerId,
        modelId: modelKey,
        providerName: provider.name ?? null,
        name: model.name ?? null,
        family: model.family ?? null,
        releaseDate: model.release_date ?? null,
        contextWindow: pickNumber(model.limit?.context) ?? null,
        maxOutput: pickNumber(model.limit?.output) ?? null,
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : null,
        reasoningOptions: reasoningOptions.length > 0 ? reasoningOptions : null,
        pricing: Object.keys(pricing).length > 0 ? pricing : null,
        status: model.status ?? null,
        checkedAt,
      });
    }
  }
  return entries;
}

// ─── Table access ────────────────────────────────────────────────────────────

/**
 * Replace the upstream catalog with `entries`. Returns the "provider/modelId"
 * keys that were not in the table before.
 */
export async function replaceModelCatalog(entries: ModelCatalogEntry[]): Promise<string[]> {
  return await getDbClient().transaction(async (tx) => {
    const before = await tx.query<{ provider: string; modelId: string }>(
      "SELECT provider, modelId FROM model_catalog",
    );
    const known = new Set(before.map((r) => `${r.provider}/${r.modelId}`));
    await tx.run("DELETE FROM model_catalog");
    const added: string[] = [];
    for (const entry of entries) {
      await tx.run(
        `INSERT INTO model_catalog
           (provider, modelId, name, family, releaseDate, contextWindow, maxOutput, reasoning,
            reasoningOptions, pricing, status, providerName, checkedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.provider,
          entry.modelId,
          ...factParams(entry),
          entry.providerName ?? null,
          entry.checkedAt,
        ],
      );
      const key = `${entry.provider}/${entry.modelId}`;
      // An empty table before means first population, not "new models".
      if (known.size > 0 && !known.has(key)) added.push(key);
    }
    return added;
  });
}

export async function touchModelCatalogCheckedAt(now: number): Promise<void> {
  await getDbClient().run("UPDATE model_catalog SET checkedAt = ?", [now]);
}

export async function listModelCatalog(): Promise<ModelCatalogEntry[]> {
  const rows = await getDbClient().query<CatalogRow>(
    "SELECT * FROM model_catalog ORDER BY provider, modelId",
  );
  return rows.map((row) => ({
    provider: row.provider,
    modelId: row.modelId,
    providerName: row.providerName,
    checkedAt: row.checkedAt,
    ...rowToFacts(row),
  }));
}

export async function countModelCatalog(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM model_catalog");
  return row?.n ?? 0;
}

export async function getModelCatalogMeta(): Promise<ModelCatalogMeta> {
  const row = await getDbClient().get<ModelCatalogMeta>(
    "SELECT etag, lastModified, lastFetchAt, lastCheckedAt FROM model_catalog_meta WHERE id = 1",
  );
  return row ?? { etag: null, lastModified: null, lastFetchAt: null, lastCheckedAt: null };
}

export async function updateModelCatalogMeta(patch: Partial<ModelCatalogMeta>): Promise<void> {
  const current = await getModelCatalogMeta();
  const next = { ...current, ...patch };
  await getDbClient().run(
    `INSERT INTO model_catalog_meta (id, etag, lastModified, lastFetchAt, lastCheckedAt)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       etag = excluded.etag,
       lastModified = excluded.lastModified,
       lastFetchAt = excluded.lastFetchAt,
       lastCheckedAt = excluded.lastCheckedAt`,
    [next.etag, next.lastModified, next.lastFetchAt, next.lastCheckedAt],
  );
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function overlayRowToEntry(row: OverlayRow): ModelCatalogOverlayEntry {
  return {
    provider: row.provider,
    modelId: row.modelId,
    reason: row.reason,
    verifiedBy: row.verifiedBy,
    expiresWhenUpstreamMatches: row.expiresWhenUpstreamMatches === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...rowToFacts(row),
  };
}

export async function listModelCatalogOverlay(): Promise<ModelCatalogOverlayEntry[]> {
  const rows = await getDbClient().query<OverlayRow>(
    "SELECT * FROM model_catalog_overlay ORDER BY provider, modelId",
  );
  return rows.map(overlayRowToEntry);
}

/**
 * Upsert one overlay row, add pricing-table rows for any of its prices that
 * have no active pricing row yet, and invalidate the in-memory catalog.
 */
export async function upsertModelCatalogOverlay(
  input: ModelCatalogOverlayInput,
  opts: { userId?: string | null; now?: number } = {},
): Promise<ModelCatalogOverlayEntry> {
  const now = opts.now ?? Date.now();
  const userId = opts.userId ?? null;
  await getDbClient().run(
    `INSERT INTO model_catalog_overlay
       (provider, modelId, name, family, releaseDate, contextWindow, maxOutput, reasoning,
        reasoningOptions, pricing, status, reason, verifiedBy, expiresWhenUpstreamMatches,
        createdAt, updatedAt, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, modelId) DO UPDATE SET
       name = excluded.name,
       family = excluded.family,
       releaseDate = excluded.releaseDate,
       contextWindow = excluded.contextWindow,
       maxOutput = excluded.maxOutput,
       reasoning = excluded.reasoning,
       reasoningOptions = excluded.reasoningOptions,
       pricing = excluded.pricing,
       status = excluded.status,
       reason = excluded.reason,
       verifiedBy = excluded.verifiedBy,
       expiresWhenUpstreamMatches = excluded.expiresWhenUpstreamMatches,
       updatedAt = excluded.updatedAt,
       updated_by = excluded.updated_by`,
    [
      input.provider,
      input.modelId,
      ...factParams(input),
      input.reason,
      input.verifiedBy ?? null,
      input.expiresWhenUpstreamMatches === false ? 0 : 1,
      now,
      now,
      userId,
      userId,
    ],
  );
  await applyOverlayPricingRows(now);
  markModelsCatalogStale();
  const row = await getDbClient().get<OverlayRow>(
    "SELECT * FROM model_catalog_overlay WHERE provider = ? AND modelId = ?",
    [input.provider, input.modelId],
  );
  if (!row) throw new Error("overlay row vanished after upsert");
  return overlayRowToEntry(row);
}

export async function deleteModelCatalogOverlay(
  provider: string,
  modelId: string,
): Promise<boolean> {
  const result = await getDbClient().run(
    "DELETE FROM model_catalog_overlay WHERE provider = ? AND modelId = ?",
    [provider, modelId],
  );
  markModelsCatalogStale();
  return result.changes > 0;
}

function factEquals(key: (typeof FACT_KEYS)[number], overlay: unknown, upstream: unknown): boolean {
  if (key === "pricing") {
    const o = overlay as ModelCatalogPricing;
    const u = (upstream ?? {}) as ModelCatalogPricing;
    return (Object.keys(o) as (keyof ModelCatalogPricing)[]).every(
      (k) => o[k] === undefined || o[k] === null || o[k] === u[k],
    );
  }
  if (key === "reasoningOptions") return JSON.stringify(overlay) === JSON.stringify(upstream);
  return overlay === upstream;
}

/**
 * Delete overlay rows flagged `expiresWhenUpstreamMatches` whose non-null facts
 * all equal the upstream row. Returns the expired "provider/modelId" keys.
 */
export async function expireMatchedOverlays(): Promise<string[]> {
  const overlays = await listModelCatalogOverlay();
  if (overlays.length === 0) return [];
  const upstream = new Map(
    (await listModelCatalog()).map((e) => [`${e.provider}/${e.modelId}`, e]),
  );
  const expired: string[] = [];
  for (const overlay of overlays) {
    if (!overlay.expiresWhenUpstreamMatches) continue;
    const key = `${overlay.provider}/${overlay.modelId}`;
    const up = upstream.get(key);
    if (!up) continue;
    const matches = FACT_KEYS.every((fact) => {
      const value = overlay[fact];
      if (value === null || value === undefined) return true;
      return factEquals(fact, value, up[fact]);
    });
    if (!matches) continue;
    await deleteModelCatalogOverlay(overlay.provider, overlay.modelId);
    expired.push(key);
  }
  return expired;
}

/**
 * Overlay prices → pricing rows, via the same models.dev projection the
 * refresh uses. Only (provider, model, tokenClass) triples with NO active
 * pricing row are written, so upstream prices are never overridden and a
 * brand-new model still gets priced by the server-side cost recompute.
 */
export async function applyOverlayPricingRows(now = Date.now()): Promise<number> {
  const overlays = await listModelCatalogOverlay();
  const synthetic: ModelsDevCache = {};
  for (const overlay of overlays) {
    if (!overlay.pricing || Object.keys(overlay.pricing).length === 0) continue;
    synthetic[overlay.provider] ??= { models: {} };
    const models = synthetic[overlay.provider]?.models;
    if (models) models[overlay.modelId] = { cost: overlay.pricing };
  }
  if (Object.keys(synthetic).length === 0) return 0;
  const rows = buildModelsDevSeedRows(synthetic);
  return await getDbClient().transaction(async () => {
    let inserted = 0;
    for (const row of rows) {
      const existing = await getActivePricingRow(row.provider, row.model, row.tokenClass, now);
      if (existing) continue;
      const input: InsertPricingRowInput = { ...row, effectiveFrom: now };
      await insertPricingRow(input);
      inserted += 1;
    }
    return inserted;
  });
}

// ─── Read path ───────────────────────────────────────────────────────────────

function toCatalogModel(modelId: string, facts: ModelCatalogFacts): CatalogModel {
  const cost =
    facts.pricing && (facts.pricing.input !== undefined || facts.pricing.output !== undefined)
      ? { input: facts.pricing.input, output: facts.pricing.output }
      : undefined;
  const reasoning =
    facts.reasoning ?? (facts.reasoningOptions && facts.reasoningOptions.length > 0 ? true : null);
  return {
    id: modelId,
    ...(facts.name ? { name: facts.name } : {}),
    ...(cost ? { cost } : {}),
    ...(facts.contextWindow != null ? { limit: { context: facts.contextWindow } } : {}),
    ...(reasoning != null ? { reasoning } : {}),
    ...(facts.reasoningOptions && facts.reasoningOptions.length > 0
      ? { reasoning_options: facts.reasoningOptions }
      : {}),
  };
}

function mergeFacts(base: ModelCatalogFacts, overlay: ModelCatalogFacts): ModelCatalogFacts {
  const merged: ModelCatalogFacts = { ...base };
  for (const key of FACT_KEYS) {
    const value = overlay[key];
    if (value === null || value === undefined) continue;
    if (key === "pricing") {
      merged.pricing = { ...(base.pricing ?? {}), ...(value as ModelCatalogPricing) };
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function applyOverlays(
  catalog: ModelsCatalog,
  baseFacts: Map<string, ModelCatalogFacts>,
  overlays: ModelCatalogOverlayEntry[],
): void {
  for (const overlay of overlays) {
    const providerId = overlay.provider as CatalogProviderId;
    const key = `${overlay.provider}/${overlay.modelId}`;
    const base = baseFacts.get(key) ?? {};
    catalog[providerId] ??= { id: providerId, models: {} };
    catalog[providerId].models[overlay.modelId] = toCatalogModel(
      overlay.modelId,
      mergeFacts(base, overlay),
    );
  }
}

function catalogModelToFacts(model: CatalogModel): ModelCatalogFacts {
  return {
    name: model.name ?? null,
    contextWindow: model.limit?.context ?? null,
    reasoning: model.reasoning ?? null,
    reasoningOptions: model.reasoning_options ?? null,
    pricing: model.cost ? { ...model.cost } : null,
  };
}

let catalogLoaded = false;

/**
 * Rebuild the in-memory catalog from `model_catalog` + overlay. Empty table →
 * vendored snapshot (with overlay rows layered on). Returns the served result.
 */
export async function reloadModelsCatalog(): Promise<ModelsCatalogResult> {
  invalidateModelsCatalog();
  const [entries, overlays, meta] = await Promise.all([
    listModelCatalog(),
    listModelCatalogOverlay(),
    getModelCatalogMeta(),
  ]);

  if (entries.length === 0) {
    if (overlays.length > 0) {
      const snapshot = snapshotModelsCatalog();
      const baseFacts = new Map<string, ModelCatalogFacts>();
      for (const [providerId, provider] of Object.entries(snapshot)) {
        for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
          baseFacts.set(`${providerId}/${modelId}`, catalogModelToFacts(model));
        }
      }
      applyOverlays(snapshot, baseFacts, overlays);
      setSnapshotOverlayCatalog(snapshot);
    }
    catalogLoaded = true;
    return getModelsCatalog();
  }

  const catalog: ModelsCatalog = {};
  const baseFacts = new Map<string, ModelCatalogFacts>();
  for (const entry of entries) {
    const providerId = entry.provider as CatalogProviderId;
    catalog[providerId] ??= {
      id: providerId,
      ...(entry.providerName ? { name: entry.providerName } : {}),
      models: {},
    };
    catalog[providerId].models[entry.modelId] = toCatalogModel(entry.modelId, entry);
    baseFacts.set(`${entry.provider}/${entry.modelId}`, entry);
  }
  applyOverlays(catalog, baseFacts, overlays);
  setLiveModelsCatalog(catalog, meta.lastFetchAt);
  catalogLoaded = true;
  return getModelsCatalog();
}

/** Mark the cached projection stale; the next `loadModelsCatalog()` rebuilds it. */
export function markModelsCatalogStale(): void {
  catalogLoaded = false;
  invalidateModelsCatalog();
}

/** Async read path used by the HTTP route: rebuilds from the DB when stale. */
export async function loadModelsCatalog(): Promise<ModelsCatalogResult> {
  if (!catalogLoaded) return await reloadModelsCatalog();
  return getModelsCatalog();
}
