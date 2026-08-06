import { loadModelsDevCache, type ModelsDevCache, type ModelsDevModel } from "./modelsdev-cache";

/**
 * Live model catalog for the UI model picker.
 *
 * The pricing-refresh loop (`src/be/pricing-refresh.ts`) already fetches the
 * full models.dev payload at boot and every 12h. This module keeps a slim
 * in-memory projection of that payload — only the providers the four local
 * harnesses' pickers can reach, and only the fields the picker reads — and
 * serves it through `GET /api/models-catalog` (`src/http/models-catalog.ts`).
 *
 * Until the first successful fetch (or if models.dev is unreachable), the
 * vendored `src/be/modelsdev-cache.json` snapshot is slimmed and served
 * instead, so the endpoint is never empty. The UI additionally bundles the
 * same snapshot as its own fallback while the request is in flight.
 */

/** Mirrors `SNAPSHOT_ORDER` + `BEDROCK_SNAPSHOT_ID` in `apps/ui/src/lib/agent-runtime-models.ts`. */
export const CATALOG_PROVIDER_IDS = [
  "openrouter",
  "anthropic",
  "openai",
  "amazon-bedrock",
] as const;

export type CatalogProviderId = (typeof CATALOG_PROVIDER_IDS)[number];

/**
 * Limited-availability models that are intentionally vendored even when
 * models.dev does not list them yet, as "provider/model-id". Shared with
 * `scripts/refresh-modelsdev-pricing.ts` (which pins them into the snapshot)
 * — the live catalog re-merges them from the snapshot so they never drop out
 * of the picker between models.dev listing gaps.
 */
export const PINNED_MODELSDEV_ENTRIES = [
  "anthropic/claude-mythos-5",
  "anthropic/claude-sonnet-5",
  "amazon-bedrock/anthropic.claude-sonnet-5",
  // models.dev delisted these codex generations in 2026-08, but they remain
  // selectable behind the API — dropping them from the snapshot broke
  // context-window lookups and reasoning-effort gating for pinned configs.
  "openai/gpt-5-codex",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-max",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.2-codex",
] as const;

export interface CatalogReasoningOption {
  type: string;
  values?: string[];
}

/** Field names deliberately match raw models.dev (`reasoning_options`, not camelCase) so the UI can treat live and bundled-snapshot data identically. */
export interface CatalogModel {
  id: string;
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  reasoning?: boolean;
  reasoning_options?: CatalogReasoningOption[];
}

export interface CatalogProvider {
  id: string;
  name?: string;
  models: Record<string, CatalogModel>;
}

export type ModelsCatalog = Partial<Record<CatalogProviderId, CatalogProvider>>;

export interface ModelsCatalogResult {
  source: "live" | "snapshot";
  /** Epoch ms of the last successful models.dev fetch; null for snapshot data. */
  updatedAt: number | null;
  providers: ModelsCatalog;
}

function slimModel(modelKey: string, model: ModelsDevModel): CatalogModel {
  const reasoningOptions = Array.isArray(model.reasoning_options)
    ? model.reasoning_options
        .filter((o) => typeof o.type === "string")
        .map((o) => ({
          type: o.type as string,
          ...(Array.isArray(o.values) ? { values: o.values } : {}),
        }))
    : [];
  return {
    id: model.id ?? modelKey,
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(model.cost !== undefined
      ? { cost: { input: model.cost.input, output: model.cost.output } }
      : {}),
    ...(model.limit?.context !== undefined ? { limit: { context: model.limit.context } } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(reasoningOptions.length > 0 ? { reasoning_options: reasoningOptions } : {}),
  };
}

/** Slim a full models.dev payload down to the picker-reachable providers/fields. */
export function buildModelsCatalog(cache: ModelsDevCache): ModelsCatalog {
  const catalog: ModelsCatalog = {};
  for (const providerId of CATALOG_PROVIDER_IDS) {
    const provider = cache[providerId];
    if (!provider?.models) continue;
    const models: Record<string, CatalogModel> = {};
    for (const [modelKey, model] of Object.entries(provider.models)) {
      models[modelKey] = slimModel(modelKey, model);
    }
    catalog[providerId] = {
      id: provider.id ?? providerId,
      ...(provider.name !== undefined ? { name: provider.name } : {}),
      models,
    };
  }
  return catalog;
}

let liveCatalog: ModelsCatalog | null = null;
let liveUpdatedAt: number | null = null;
/** Memoized slim of the vendored snapshot; `null` = load attempted and failed. */
let snapshotCatalog: ModelsCatalog | null | undefined;

function bundledSnapshotCatalog(): ModelsCatalog {
  if (snapshotCatalog === undefined) {
    const raw = loadModelsDevCache();
    snapshotCatalog = raw ? buildModelsCatalog(raw) : null;
  }
  return snapshotCatalog ?? {};
}

function mergePinnedEntries(catalog: ModelsCatalog): void {
  const snapshot = bundledSnapshotCatalog();
  for (const entryPath of PINNED_MODELSDEV_ENTRIES) {
    const slashIndex = entryPath.indexOf("/");
    const providerId = entryPath.slice(0, slashIndex) as CatalogProviderId;
    const modelId = entryPath.slice(slashIndex + 1);
    if (catalog[providerId]?.models[modelId]) continue;
    const pinned = snapshot[providerId]?.models[modelId];
    if (!pinned) continue;
    catalog[providerId] ??= { id: providerId, models: {} };
    catalog[providerId].models[modelId] = pinned;
  }
}

/** Called by the pricing-refresh loop after every successful full models.dev fetch. */
export function updateLiveModelsCatalog(cache: ModelsDevCache, now = Date.now()): void {
  const catalog = buildModelsCatalog(cache);
  mergePinnedEntries(catalog);
  liveCatalog = catalog;
  liveUpdatedAt = now;
}

export function getModelsCatalog(): ModelsCatalogResult {
  if (liveCatalog) {
    return { source: "live", updatedAt: liveUpdatedAt, providers: liveCatalog };
  }
  return { source: "snapshot", updatedAt: null, providers: bundledSnapshotCatalog() };
}

export function resetModelsCatalogForTests(): void {
  liveCatalog = null;
  liveUpdatedAt = null;
}
