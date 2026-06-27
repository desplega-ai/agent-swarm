import type { ModelsDevCache } from "@swarm/ai-pricing";
import { scrubSecrets } from "@swarm/core-utils";
import {
  createLogEntry,
  getActivePricingRow,
  getDb,
  type InsertPricingRowInput,
  insertPricingRow,
} from "./db";
import { buildModelsDevSeedRows, type PricingSeedRow } from "./seed-pricing";

const MODELSDEV_API_URL = "https://models.dev/api.json";
export const PRICING_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

let lastETag: string | null = null;
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
}

function logPricingRefresh(message: string): void {
  console.log(scrubSecrets(`[pricing-refresh] ${message}`));
}

function logPricingRefreshError(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(scrubSecrets(`[pricing-refresh] ${message}: ${detail}`));
}

function insertChangedPricingRows(
  rows: PricingSeedRow[],
  now: number,
): {
  inserted: number;
  unchanged: number;
} {
  let inserted = 0;
  let unchanged = 0;

  const tx = getDb().transaction((seedRows: PricingSeedRow[]) => {
    for (const row of seedRows) {
      const existing = getActivePricingRow(row.provider, row.model, row.tokenClass, now);
      if (existing?.pricePerMillionUsd === row.pricePerMillionUsd) {
        unchanged += 1;
        continue;
      }

      const input: InsertPricingRowInput = {
        ...row,
        effectiveFrom: now,
      };
      insertPricingRow(input);
      inserted += 1;
    }
  });

  tx(rows);
  return { inserted, unchanged };
}

function prunePricingHistory(keepLatest = 2): number {
  const result = getDb()
    .prepare(
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
    )
    .run(keepLatest);
  return result.changes;
}

function auditPricingRefresh(result: PricingRefreshResult): void {
  try {
    createLogEntry({
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

function auditPricingRefreshFailure(err: unknown): void {
  try {
    createLogEntry({
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
  const headers: Record<string, string> = lastETag ? { "If-None-Match": lastETag } : {};

  const response = await fetchImpl(MODELSDEV_API_URL, { headers });
  if (response.status === 304) {
    const result: PricingRefreshResult = {
      status: "not_modified",
      candidateRows: 0,
      inserted: 0,
      unchanged: 0,
      pruned: 0,
      etag: lastETag ?? undefined,
    };
    auditPricingRefresh(result);
    logPricingRefresh("models.dev returned 304; pricing rows unchanged");
    return result;
  }
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`);
  }

  const cache = (await response.json()) as ModelsDevCache;
  const etag = response.headers.get("etag");
  const rows = buildModelsDevSeedRows(cache);
  const { inserted, unchanged } = insertChangedPricingRows(rows, now);
  const pruned = prunePricingHistory(2);
  lastETag = etag;

  const result: PricingRefreshResult = {
    status: "refreshed",
    candidateRows: rows.length,
    inserted,
    unchanged,
    pruned,
    etag: lastETag ?? undefined,
  };
  auditPricingRefresh(result);
  logPricingRefresh(
    `refreshed ${rows.length} candidate row(s); inserted=${inserted}; unchanged=${unchanged}; pruned=${pruned}`,
  );
  return result;
}

async function runPricingRefreshSafely(): Promise<void> {
  try {
    await refreshPricingFromModelsDev();
  } catch (err) {
    logPricingRefreshError("refresh failed", err);
    auditPricingRefreshFailure(err);
  }
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
