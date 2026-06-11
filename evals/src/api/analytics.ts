/**
 * Pure analytics aggregation (v5 spec §1 — WP-AAPI). `buildAnalytics` turns the
 * joined attempts × runs rows (SQL lives in server.ts) plus the registry into a
 * pre-aggregated AnalyticsResponse — the response carries ONLY aggregates,
 * never the raw attempt list.
 *
 * Null-safety rules (§1.3, frozen):
 *   - priced attempt := costUsd !== null (a genuine $0 harness cost is priced);
 *   - means aggregate only non-null values;
 *   - every ratio is null (never NaN/Infinity) on a zero denominator;
 *   - stored sandbox versions are re-cleaned with cleanVersion() on read —
 *     historical rows carry ANSI-dirty values;
 *   - error attempts are infra failures: counted, never lowering a pass rate.
 */

import type { Registry } from "../runner/index.ts";
import { cleanVersion } from "../swarm/version.ts";
import type {
  AnalyticsCell,
  AnalyticsModel,
  AnalyticsResponse,
  AnalyticsSeries,
  AnalyticsSeriesPoint,
  AnalyticsVersionEvent,
} from "../types.ts";

/** One attempt joined with its run — the SQL row feeding buildAnalytics (§1.1, columns frozen). */
export interface AnalyticsSourceRow {
  runId: string;
  scenarioId: string;
  configId: string;
  /** AttemptStatus as stored; any status counts toward `attempts`. */
  status: string;
  score: number | null;
  costUsd: number | null;
  costSource: string | null;
  judgeCostUsd: number | null;
  durationMs: number | null;
  /** json_extract(tokens_json, '$.model') — dominant observed model id. */
  tokenModel: string | null;
  /** Raw stored sandbox versions — may carry ANSI dirt; cleaned on read. */
  apiVersion: string | null;
  workerVersion: string | null;
  runName: string | null;
  runCreatedAt: string;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Mean over the given values; null when empty (never NaN). */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = sum(values) / values.length;
  return Number.isFinite(v) ? v : null;
}

/** numerator / denominator; null on a zero/negative denominator or non-finite result. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

/** Model key precedence (§1.2): tokens.model → registry config.model → "(configId)". */
function modelKey(row: AnalyticsSourceRow, registry: Registry): string {
  if (row.tokenModel && row.tokenModel.trim().length > 0) return row.tokenModel;
  const configModel = registry.configs.get(row.configId)?.model;
  if (configModel && configModel.length > 0) return configModel;
  return `(${row.configId})`;
}

/** Shared per-group metric accumulation (cells, per-run points). */
interface MetricAcc {
  attempts: number;
  graded: number;
  passed: number;
  errors: number;
  costs: number[];
  judgeCosts: number[];
  durations: number[];
  scores: number[];
}

function newMetricAcc(): MetricAcc {
  return {
    attempts: 0,
    graded: 0,
    passed: 0,
    errors: 0,
    costs: [],
    judgeCosts: [],
    durations: [],
    scores: [],
  };
}

function accumulate(acc: MetricAcc, row: AnalyticsSourceRow): void {
  acc.attempts += 1;
  if (row.status === "passed" || row.status === "failed") acc.graded += 1;
  if (row.status === "passed") acc.passed += 1;
  if (row.status === "error") acc.errors += 1;
  if (row.costUsd !== null) acc.costs.push(row.costUsd);
  if (row.judgeCostUsd !== null) acc.judgeCosts.push(row.judgeCostUsd);
  if (row.durationMs !== null) acc.durations.push(row.durationMs);
  if (row.score !== null) acc.scores.push(row.score);
}

interface RunAcc extends MetricAcc {
  runId: string;
  runName: string | null;
  createdAt: string;
  /** First non-null cleaned version among the cell's attempts. */
  apiVersion: string | null;
  workerVersion: string | null;
}

interface CellAcc extends MetricAcc {
  scenarioId: string;
  configId: string;
  lastRunAt: string | null;
  /** Per-run accumulators — become the cell's series points. */
  runs: Map<string, RunAcc>;
}

interface ModelAcc extends MetricAcc {
  model: string;
  providers: Set<string>;
  configIds: Set<string>;
  runIds: Set<string>;
  /** Runs with ≥1 priced attempt (avgCostPerRun denominator). */
  pricedRunIds: Set<string>;
  /** Σ over attempts having BOTH costUsd and durationMs ($/minute subset). */
  pairedCostUsd: number;
  pairedDurationMs: number;
}

export function buildAnalytics(rows: AnalyticsSourceRow[], registry: Registry): AnalyticsResponse {
  const scenarioIds: string[] = [];
  const configIds: string[] = [];
  const cells = new Map<string, CellAcc>();
  const models = new Map<string, ModelAcc>();

  for (const row of rows) {
    if (!scenarioIds.includes(row.scenarioId)) scenarioIds.push(row.scenarioId);
    if (!configIds.includes(row.configId)) configIds.push(row.configId);

    // ---- matrix cell ----
    const cellKey = `${row.scenarioId}\u0000${row.configId}`;
    let cell = cells.get(cellKey);
    if (!cell) {
      cell = {
        ...newMetricAcc(),
        scenarioId: row.scenarioId,
        configId: row.configId,
        lastRunAt: null,
        runs: new Map(),
      };
      cells.set(cellKey, cell);
    }
    accumulate(cell, row);
    if (cell.lastRunAt === null || row.runCreatedAt > cell.lastRunAt) {
      cell.lastRunAt = row.runCreatedAt;
    }

    // ---- series point (per run within the cell) ----
    let runAcc = cell.runs.get(row.runId);
    if (!runAcc) {
      runAcc = {
        ...newMetricAcc(),
        runId: row.runId,
        runName: row.runName,
        createdAt: row.runCreatedAt,
        apiVersion: null,
        workerVersion: null,
      };
      cell.runs.set(row.runId, runAcc);
    }
    accumulate(runAcc, row);
    const apiVersion = cleanVersion(row.apiVersion);
    const workerVersion = cleanVersion(row.workerVersion);
    if (runAcc.apiVersion === null && apiVersion !== null) runAcc.apiVersion = apiVersion;
    if (runAcc.workerVersion === null && workerVersion !== null) {
      runAcc.workerVersion = workerVersion;
    }

    // ---- model rollup ----
    const model = modelKey(row, registry);
    let modelAcc = models.get(model);
    if (!modelAcc) {
      modelAcc = {
        ...newMetricAcc(),
        model,
        providers: new Set(),
        configIds: new Set(),
        runIds: new Set(),
        pricedRunIds: new Set(),
        pairedCostUsd: 0,
        pairedDurationMs: 0,
      };
      models.set(model, modelAcc);
    }
    accumulate(modelAcc, row);
    const config = registry.configs.get(row.configId);
    if (config) modelAcc.providers.add(config.provider);
    modelAcc.configIds.add(row.configId);
    modelAcc.runIds.add(row.runId);
    if (row.costUsd !== null) modelAcc.pricedRunIds.add(row.runId);
    if (row.costUsd !== null && row.durationMs !== null) {
      modelAcc.pairedCostUsd += row.costUsd;
      modelAcc.pairedDurationMs += row.durationMs;
    }
  }

  const matrix: AnalyticsCell[] = [...cells.values()].map((cell) => {
    const totalCostUsd = cell.costs.length ? sum(cell.costs) : null;
    const totalJudgeCostUsd = cell.judgeCosts.length ? sum(cell.judgeCosts) : null;
    return {
      scenarioId: cell.scenarioId,
      configId: cell.configId,
      attempts: cell.attempts,
      graded: cell.graded,
      passed: cell.passed,
      errors: cell.errors,
      passRate: ratio(cell.passed, cell.graded),
      pricedAttempts: cell.costs.length,
      totalCostUsd,
      avgCostUsd: totalCostUsd === null ? null : ratio(totalCostUsd, cell.costs.length),
      judgePricedAttempts: cell.judgeCosts.length,
      totalJudgeCostUsd,
      avgJudgeCostUsd: mean(cell.judgeCosts),
      avgDurationMs: mean(cell.durations),
      avgScore: mean(cell.scores),
      lastRunAt: cell.lastRunAt,
    };
  });

  const modelRollups: AnalyticsModel[] = [...models.values()]
    .map((m) => {
      const totalCostUsd = m.costs.length ? sum(m.costs) : null;
      return {
        model: m.model,
        providers: [...m.providers],
        configIds: [...m.configIds],
        runs: m.runIds.size,
        attempts: m.attempts,
        graded: m.graded,
        passed: m.passed,
        errors: m.errors,
        passRate: ratio(m.passed, m.graded),
        avgScore: mean(m.scores),
        pricedAttempts: m.costs.length,
        totalCostUsd,
        avgCostPerAttempt: totalCostUsd === null ? null : ratio(totalCostUsd, m.costs.length),
        avgCostPerRun: totalCostUsd === null ? null : ratio(totalCostUsd, m.pricedRunIds.size),
        // Null when the both-fields subset is empty OR Σduration is 0 (§1.3).
        costPerMinute:
          m.pairedDurationMs > 0 ? ratio(m.pairedCostUsd, m.pairedDurationMs / 60_000) : null,
        avgDurationMs: mean(m.durations),
      };
    })
    .sort((a, b) => b.attempts - a.attempts || a.model.localeCompare(b.model));

  const series: AnalyticsSeries[] = [...cells.values()].map((cell) => {
    const points: AnalyticsSeriesPoint[] = [...cell.runs.values()]
      .sort((a, b) =>
        a.createdAt < b.createdAt
          ? -1
          : a.createdAt > b.createdAt
            ? 1
            : a.runId.localeCompare(b.runId),
      )
      .map((p) => {
        const totalCostUsd = p.costs.length ? sum(p.costs) : null;
        return {
          runId: p.runId,
          runName: p.runName,
          createdAt: p.createdAt,
          attempts: p.attempts,
          graded: p.graded,
          passRate: ratio(p.passed, p.graded),
          avgScore: mean(p.scores),
          totalCostUsd,
          avgCostUsd: totalCostUsd === null ? null : ratio(totalCostUsd, p.costs.length),
          avgJudgeCostUsd: mean(p.judgeCosts),
          avgDurationMs: mean(p.durations),
          apiVersion: p.apiVersion,
          workerVersion: p.workerVersion,
        };
      });

    // §1.3 versionEvents: track last seen non-null per kind; emit on change
    // (first non-null → from: null). Null-version points neither emit nor reset.
    const versionEvents: AnalyticsVersionEvent[] = [];
    let lastApi: string | null = null;
    let lastWorker: string | null = null;
    for (const point of points) {
      if (point.apiVersion !== null && point.apiVersion !== lastApi) {
        versionEvents.push({
          runId: point.runId,
          createdAt: point.createdAt,
          kind: "api",
          from: lastApi,
          to: point.apiVersion,
        });
        lastApi = point.apiVersion;
      }
      if (point.workerVersion !== null && point.workerVersion !== lastWorker) {
        versionEvents.push({
          runId: point.runId,
          createdAt: point.createdAt,
          kind: "worker",
          from: lastWorker,
          to: point.workerVersion,
        });
        lastWorker = point.workerVersion;
      }
    }

    return { scenarioId: cell.scenarioId, configId: cell.configId, points, versionEvents };
  });

  return {
    generatedAt: new Date().toISOString(),
    scenarioIds,
    configIds,
    matrix,
    models: modelRollups,
    series,
  };
}
