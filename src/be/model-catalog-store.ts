/**
 * Persistent model catalog (migration 184).
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

import { withAgentChatRegistrySections } from "@desplega/model-catalog";
import type {
  ModelCatalogFactRow,
  ModelCatalogFactValues,
  ModelCatalogOverlayRow,
  ModelCatalogRow,
} from "@desplega/storage";
import { type RuntimeCatalog, setRuntimeModelCatalog } from "../utils/runtime-model-catalog";
import { getActivePricingRow, type InsertPricingRowInput, insertPricingRow } from "./db";
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
import { getStorage } from "./storage";

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

function rowToFacts(row: ModelCatalogFactRow): ModelCatalogFacts {
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

function factValues(facts: ModelCatalogFacts): ModelCatalogFactValues {
  return {
    name: facts.name ?? null,
    family: facts.family ?? null,
    releaseDate: facts.releaseDate ?? null,
    contextWindow: facts.contextWindow ?? null,
    maxOutput: facts.maxOutput ?? null,
    reasoning:
      facts.reasoning === undefined || facts.reasoning === null ? null : Boolean(facts.reasoning),
    reasoningOptions: facts.reasoningOptions ? JSON.stringify(facts.reasoningOptions) : null,
    pricing: facts.pricing ? JSON.stringify(facts.pricing) : null,
    status: facts.status ?? null,
  };
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
export function buildCatalogEntries(raw: ModelsDevCache, checkedAt: number): ModelCatalogEntry[] {
  // A live models.dev payload still carries the embeddings and image models of
  // the registry gateways (`vercel`); pi and opencode cannot run them.
  const cache = withAgentChatRegistrySections(raw);
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
  const models = getStorage().repos.models;
  return await getStorage().transaction(async () => {
    const before = await models.listCatalogKeys();
    const known = new Set(before.map((r) => `${r.provider}/${r.modelId}`));
    await models.deleteAllCatalog();
    const added: string[] = [];
    for (const entry of entries) {
      await models.insertCatalogRow({
        provider: entry.provider,
        modelId: entry.modelId,
        ...factValues(entry),
        providerName: entry.providerName ?? null,
        checkedAt: entry.checkedAt,
      });
      const key = `${entry.provider}/${entry.modelId}`;
      // An empty table before means first population, not "new models".
      if (known.size > 0 && !known.has(key)) added.push(key);
    }
    return added;
  });
}

export async function touchModelCatalogCheckedAt(now: number): Promise<void> {
  await getStorage().repos.models.touchCatalogCheckedAt(now);
}

export async function listModelCatalog(): Promise<ModelCatalogEntry[]> {
  const rows: ModelCatalogRow[] = await getStorage().repos.models.listCatalog();
  return rows.map((row) => ({
    provider: row.provider,
    modelId: row.modelId,
    providerName: row.providerName,
    checkedAt: row.checkedAt,
    ...rowToFacts(row),
  }));
}

export async function countModelCatalog(): Promise<number> {
  return await getStorage().repos.models.countCatalog();
}

export async function getModelCatalogMeta(): Promise<ModelCatalogMeta> {
  const row = await getStorage().repos.models.getCatalogMeta();
  return row ?? { etag: null, lastModified: null, lastFetchAt: null, lastCheckedAt: null };
}

export async function updateModelCatalogMeta(patch: Partial<ModelCatalogMeta>): Promise<void> {
  const current = await getModelCatalogMeta();
  const next = { ...current, ...patch };
  await getStorage().repos.models.upsertCatalogMeta({
    etag: next.etag,
    lastModified: next.lastModified,
    lastFetchAt: next.lastFetchAt,
    lastCheckedAt: next.lastCheckedAt,
  });
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function overlayRowToEntry(row: ModelCatalogOverlayRow): ModelCatalogOverlayEntry {
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
  const rows = await getStorage().repos.models.listOverlay();
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
  await getStorage().repos.models.upsertOverlay({
    provider: input.provider,
    modelId: input.modelId,
    ...factValues(input),
    reason: input.reason,
    verifiedBy: input.verifiedBy ?? null,
    expiresWhenUpstreamMatches: input.expiresWhenUpstreamMatches !== false,
    now,
    actor: userId,
  });
  await applyOverlayPricingRows(now);
  markModelsCatalogStale();
  const row = await getStorage().repos.models.findOverlay(input.provider, input.modelId);
  if (!row) throw new Error("overlay row vanished after upsert");
  return overlayRowToEntry(row);
}

export async function deleteModelCatalogOverlay(
  provider: string,
  modelId: string,
): Promise<boolean> {
  const changes = await getStorage().repos.models.deleteOverlay(provider, modelId);
  markModelsCatalogStale();
  return changes > 0;
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
 * refresh uses. A (provider, model, tokenClass) triple with NO active pricing
 * row is written, so upstream prices are never overridden and a brand-new
 * model still gets priced by the server-side cost recompute. For an
 * overlay-only model (no upstream catalog row) the overlay is the only price
 * source, so a corrected overlay price supersedes its earlier row.
 */
export async function applyOverlayPricingRows(now = Date.now()): Promise<number> {
  const overlays = await listModelCatalogOverlay();
  const upstream = new Set((await listModelCatalog()).map((e) => `${e.provider}/${e.modelId}`));
  const synthetic: ModelsDevCache = {};
  const overlayOnly: ModelsDevCache = {};
  for (const overlay of overlays) {
    if (!overlay.pricing || Object.keys(overlay.pricing).length === 0) continue;
    for (const target of upstream.has(`${overlay.provider}/${overlay.modelId}`)
      ? [synthetic]
      : [synthetic, overlayOnly]) {
      target[overlay.provider] ??= { models: {} };
      const models = target[overlay.provider]?.models;
      if (models) models[overlay.modelId] = { cost: overlay.pricing };
    }
  }
  if (Object.keys(synthetic).length === 0) return 0;
  const rows = buildModelsDevSeedRows(synthetic);
  const tripleKey = (r: { provider: string; model: string; tokenClass: string }) =>
    `${r.provider}|${r.model}|${r.tokenClass}`;
  // The projection also emits rows for an empty provider block (shortname
  // fallbacks); those are not owned by any overlay-only model.
  const emptyBlocks: ModelsDevCache = Object.fromEntries(
    Object.keys(overlayOnly).map((provider) => [provider, { models: {} }]),
  );
  const fallbackKeys = new Set(buildModelsDevSeedRows(emptyBlocks).map(tripleKey));
  const overlayOwned = new Set(
    buildModelsDevSeedRows(overlayOnly)
      .map(tripleKey)
      .filter((key) => !fallbackKeys.has(key)),
  );
  return await getStorage().transaction(async () => {
    let inserted = 0;
    for (const row of rows) {
      const existing = await getActivePricingRow(row.provider, row.model, row.tokenClass, now);
      if (existing) {
        if (!overlayOwned.has(tripleKey(row))) continue;
        if (existing.pricePerMillionUsd === row.pricePerMillionUsd) continue;
        if (existing.effectiveFrom === now) {
          await getStorage().repos.sessions.updatePricingPrice(
            row.provider,
            row.model,
            row.tokenClass,
            now,
            row.pricePerMillionUsd,
            now,
          );
          inserted += 1;
          continue;
        }
      }
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
      ? {
          input: facts.pricing.input,
          output: facts.pricing.output,
          ...(facts.pricing.cache_read !== undefined
            ? { cache_read: facts.pricing.cache_read }
            : {}),
          ...(facts.pricing.cache_write !== undefined
            ? { cache_write: facts.pricing.cache_write }
            : {}),
        }
      : undefined;
  const reasoning =
    facts.reasoning ?? (facts.reasoningOptions && facts.reasoningOptions.length > 0 ? true : null);
  return {
    id: modelId,
    ...(facts.name ? { name: facts.name } : {}),
    ...(cost ? { cost } : {}),
    ...(facts.contextWindow != null || facts.maxOutput != null
      ? {
          limit: {
            ...(facts.contextWindow != null ? { context: facts.contextWindow } : {}),
            ...(facts.maxOutput != null ? { output: facts.maxOutput } : {}),
          },
        }
      : {}),
    ...(facts.releaseDate ? { release_date: facts.releaseDate } : {}),
    ...(facts.status ? { status: facts.status } : {}),
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
    releaseDate: model.release_date ?? null,
    status: model.status ?? null,
    reasoning: model.reasoning ?? null,
    reasoningOptions: model.reasoning_options ?? null,
    pricing: model.cost ? { ...model.cost } : null,
  };
}

let catalogLoaded = false;
let catalogGeneration = 0;

/**
 * Bumped by every reload and stale mark, i.e. after each refresh or overlay
 * write. Caches derived from the catalog tables (tier resolution) compare it
 * to drop entries that predate a write, instead of waiting out their TTL.
 */
export function getCatalogGeneration(): number {
  return catalogGeneration;
}

/**
 * Rebuild the in-memory catalog from `model_catalog` + overlay. Empty table →
 * vendored snapshot (with overlay rows layered on). Returns the served result.
 */
export async function reloadModelsCatalog(): Promise<ModelsCatalogResult> {
  catalogGeneration++;
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
    return publishRuntimeCatalog(getModelsCatalog());
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
  return publishRuntimeCatalog(getModelsCatalog());
}

/** Hand the served projection to in-process consumers (adapters, context math). */
function publishRuntimeCatalog(result: ModelsCatalogResult): ModelsCatalogResult {
  setRuntimeModelCatalog(result.providers as RuntimeCatalog, Date.now(), result.source);
  return result;
}

/** Mark the cached projection stale; the next `loadModelsCatalog()` rebuilds it. */
export function markModelsCatalogStale(): void {
  catalogLoaded = false;
  catalogGeneration++;
  invalidateModelsCatalog();
}

/** Async read path used by the HTTP route: rebuilds from the DB when stale. */
export async function loadModelsCatalog(): Promise<ModelsCatalogResult> {
  if (!catalogLoaded) return await reloadModelsCatalog();
  return getModelsCatalog();
}
