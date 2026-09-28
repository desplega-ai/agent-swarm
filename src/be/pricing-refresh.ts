import { scrubSecrets } from "../utils/secret-scrubber";
import {
  createLogEntry,
  getActivePricingRow,
  getDbClient,
  type InsertPricingRowInput,
  insertPricingRow,
} from "./db";
import {
  applyOverlayPricingRows,
  buildCatalogEntries,
  countModelCatalog,
  expireMatchedOverlays,
  getModelCatalogMeta,
  reloadModelsCatalog,
  replaceModelCatalog,
  touchModelCatalogCheckedAt,
  updateModelCatalogMeta,
} from "./model-catalog-store";
import type { ModelsDevCache } from "./modelsdev-cache";
import { buildModelsDevSeedRows, type PricingSeedRow } from "./seed-pricing";

const MODELSDEV_API_URL = "https://models.dev/api.json";
export const PRICING_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Unforced `refreshModelCatalog()` calls skip the network when the last models.dev check (200 or 304) is younger than this. */
export const MODEL_CATALOG_FRESH_MS = 4 * 60 * 60 * 1000;

let refreshLoopStarted = false;

interface RefreshPricingOptions {
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface PricingRefreshResult {
  status: "refreshed" | "not_modified";
  candidateRows: number;
  inserted: number;
  unchanged: number;
  pruned: number;
  etag?: string;
  /** Catalog keys ("provider/modelId") new since the previous fetch. */
  added?: string[];
  /** Overlay rows auto-expired because upstream now matches. */
  expiredOverlays?: string[];
  catalogModels?: number;
}

function logPricingRefresh(message: string): void {
  console.log(scrubSecrets(`[pricing-refresh] ${message}`));
}

function logPricingRefreshError(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(scrubSecrets(`[pricing-refresh] ${message}: ${detail}`));
}

/**
 * The per-row reads and writes go through the async client helpers; inside the
 * transaction callback they are routed into the same open BEGIN.
 */
async function insertChangedPricingRows(
  rows: PricingSeedRow[],
  now: number,
): Promise<{
  inserted: number;
  unchanged: number;
}> {
  return await getDbClient().transaction(async () => {
    let inserted = 0;
    let unchanged = 0;

    for (const row of rows) {
      const existing = await getActivePricingRow(row.provider, row.model, row.tokenClass, now);
      if (existing?.pricePerMillionUsd === row.pricePerMillionUsd) {
        unchanged += 1;
        continue;
      }

      const input: InsertPricingRowInput = {
        ...row,
        effectiveFrom: now,
      };
      await insertPricingRow(input);
      inserted += 1;
    }

    return { inserted, unchanged };
  });
}

async function prunePricingHistory(keepLatest = 2): Promise<number> {
  const result = await getDbClient().run(
    `DELETE FROM pricing
     WHERE rowid IN (
       SELECT rowid
       FROM (
         SELECT
           rowid,
           ROW_NUMBER() OVER (
             PARTITION BY provider, model, token_class
             ORDER BY effective_from DESC
           ) AS rn
         FROM pricing
       )
       WHERE rn > ?
     )`,
    [keepLatest],
  );
  return result.changes;
}

async function auditPricingRefresh(result: PricingRefreshResult): Promise<void> {
  try {
    await createLogEntry({
      eventType: "pricing.refresh",
      newValue: `${result.status}: inserted=${result.inserted}; unchanged=${result.unchanged}; pruned=${result.pruned}`,
      metadata: {
        status: result.status,
        candidateRows: result.candidateRows,
        inserted: result.inserted,
        unchanged: result.unchanged,
        pruned: result.pruned,
        etag: result.etag,
      },
    });
  } catch (err) {
    logPricingRefreshError("audit log write failed", err);
  }
}

async function auditPricingRefreshFailure(err: unknown): Promise<void> {
  try {
    await createLogEntry({
      eventType: "pricing.refresh.failed",
      newValue: scrubSecrets(err instanceof Error ? err.message : String(err)),
    });
  } catch (auditErr) {
    logPricingRefreshError("failure audit log write failed", auditErr);
  }
}

export async function refreshPricingFromModelsDev(
  opts: RefreshPricingOptions = {},
): Promise<PricingRefreshResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const meta = await getModelCatalogMeta();
  // Only send validators when the table is populated — a 304 against an empty
  // table (fresh DB, same ETag) would leave the catalog empty.
  const catalogCount = await countModelCatalog();
  const headers: Record<string, string> = {};
  if (catalogCount > 0 && meta.etag) headers["If-None-Match"] = meta.etag;
  if (catalogCount > 0 && meta.lastModified) headers["If-Modified-Since"] = meta.lastModified;

  const response = await fetchImpl(MODELSDEV_API_URL, { headers });
  if (response.status === 304) {
    await touchModelCatalogCheckedAt(now);
    await updateModelCatalogMeta({ lastCheckedAt: now });
    await reloadModelsCatalog();
    const result: PricingRefreshResult = {
      status: "not_modified",
      candidateRows: 0,
      inserted: 0,
      unchanged: 0,
      pruned: 0,
      etag: meta.etag ?? undefined,
      added: [],
      expiredOverlays: [],
      catalogModels: catalogCount,
    };
    await auditPricingRefresh(result);
    logPricingRefresh("models.dev returned 304; pricing rows unchanged");
    return result;
  }
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`);
  }

  const cache = (await response.json()) as ModelsDevCache;
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  const entries = buildCatalogEntries(cache, now);
  const added = await replaceModelCatalog(entries);
  const rows = buildModelsDevSeedRows(cache);
  const { inserted, unchanged } = await insertChangedPricingRows(rows, now);
  const expiredOverlays = await expireMatchedOverlays();
  // Overlay prices only fill (provider, model, tokenClass) gaps upstream left.
  const overlayInserted = await applyOverlayPricingRows(now);
  const pruned = await prunePricingHistory(2);
  await updateModelCatalogMeta({ etag, lastModified, lastFetchAt: now, lastCheckedAt: now });
  await reloadModelsCatalog();

  const result: PricingRefreshResult = {
    status: "refreshed",
    candidateRows: rows.length,
    inserted: inserted + overlayInserted,
    unchanged,
    pruned,
    etag: etag ?? undefined,
    added,
    expiredOverlays,
    catalogModels: entries.length,
  };
  await auditPricingRefresh(result);
  logPricingRefresh(
    `refreshed ${rows.length} candidate row(s); inserted=${inserted}; unchanged=${unchanged}; pruned=${pruned}; catalog=${entries.length}; added=${added.length}; expiredOverlays=${expiredOverlays.length}`,
  );
  return result;
}

export interface ModelCatalogRefreshResult {
  status: "updated" | "not-modified" | "skipped-fresh" | "error";
  models: number;
  added: string[];
  checkedAt: number | null;
  error?: string;
}

/**
 * `pi update --models` for the swarm. Unforced calls skip the network when the
 * last fetch is younger than MODEL_CATALOG_FRESH_MS; `force` always fetches
 * (still conditional on the stored ETag). Never throws — failures come back as
 * `status: "error"` and the catalog keeps serving the last good table (or the
 * vendored snapshot).
 */
export async function refreshModelCatalog(
  opts: { force?: boolean } & RefreshPricingOptions = {},
): Promise<ModelCatalogRefreshResult> {
  const now = opts.now ?? Date.now();
  try {
    const meta = await getModelCatalogMeta();
    const count = await countModelCatalog();
    if (
      !opts.force &&
      count > 0 &&
      meta.lastCheckedAt !== null &&
      now - meta.lastCheckedAt < MODEL_CATALOG_FRESH_MS
    ) {
      await reloadModelsCatalog();
      return { status: "skipped-fresh", models: count, added: [], checkedAt: meta.lastCheckedAt };
    }
    const result = await refreshPricingFromModelsDev({ fetchImpl: opts.fetchImpl, now });
    return {
      status: result.status === "refreshed" ? "updated" : "not-modified",
      models: result.catalogModels ?? (await countModelCatalog()),
      added: result.added ?? [],
      checkedAt: now,
    };
  } catch (err) {
    logPricingRefreshError("model catalog refresh failed", err);
    await auditPricingRefreshFailure(err);
    const meta = await getModelCatalogMeta().catch(() => null);
    return {
      status: "error",
      models: await countModelCatalog().catch(() => 0),
      added: [],
      checkedAt: meta?.lastCheckedAt ?? null,
      error: scrubSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function runPricingRefreshSafely(): Promise<void> {
  // refreshModelCatalog never throws; errors are logged + audited inside.
  await refreshModelCatalog();
}

export function startPricingRefreshLoop(): void {
  if (refreshLoopStarted) return;
  refreshLoopStarted = true;

  void runPricingRefreshSafely();
  const interval = setInterval(() => {
    void runPricingRefreshSafely();
  }, PRICING_REFRESH_INTERVAL_MS);
  interval.unref?.();
}
