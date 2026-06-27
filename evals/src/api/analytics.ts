/**
 * Pure analytics aggregation (v5 spec §1 + v7 spec §6/§7/§11 — WP-AAPI).
 * `buildAnalytics` turns the joined attempts × runs rows (SQL lives in
 * server.ts) plus the registry into a pre-aggregated AnalyticsResponse — the
 * response carries ONLY aggregates, never the raw attempt list.
 *
 * Null-safety rules (§1.3, frozen):
 *   - priced attempt := costUsd !== null (a genuine $0 harness cost is priced);
 *   - means aggregate only non-null values;
 *   - every ratio is null (never NaN/Infinity) on a zero denominator;
 *   - stored sandbox versions are re-cleaned with cleanVersion() on read —
 *     historical rows carry ANSI-dirty values;
 *   - error attempts are infra failures: counted, never lowering a pass rate.
 *
 * v7 additions (frozen rules, spec §6.1/§7/§11):
 *   - min/max cost over a group's priced attempts; null when 0 priced;
 *   - token sums over token-bearing attempts (any token field > 0); the whole
 *     AnalyticsTokenSums object is null when a group has none;
 *   - bare claude aliases ("fable", "haiku", …) in the model key resolve to
 *     the latest concrete family id via the §8 alias map BEFORE grouping —
 *     historical rows and config-model fallbacks group identically;
 *   - rollups by harness (registry provider; configId-prefix fallback) and by
 *     model vendor (vendorOfModelKey), plus one scatter point per model key.
 *
 * v7.6 §C3 (frozen): an optional AnalyticsFilter narrows the source rows
 * BEFORE aggregation — per-model / per-vendor / scatter aggregates cannot be
 * recomputed client-side from the pre-aggregated cells (mean-of-means error).
 * filterOptions is computed over ALL input rows first so the filter bar keeps
 * every option visible while a filter is active; unknown filter values match
 * nothing (empty aggregates, never an error).
 */

import { resolveClaudeAlias } from "../cost/model-alias.ts";
import type { Registry } from "../runner/index.ts";
import { cleanVersion } from "../swarm/version.ts";
import type {
  AnalyticsCell,
  AnalyticsFilter,
  AnalyticsFilterOptions,
  AnalyticsGroupRollup,
  AnalyticsModel,
  AnalyticsResponse,
  AnalyticsScatterPoint,
  AnalyticsSeries,
  AnalyticsSeriesPoint,
  AnalyticsTokenSums,
  AnalyticsVersionEvent,
} from "../types.ts";

/** One attempt joined with its run — the SQL row feeding buildAnalytics (§1.1 + v7 §6.1). */
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
  /** json_extract(tokens_json, '$.inputTokens') — null on rows without token capture (v7 §6.1). */
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenCacheRead: number | null;
  tokenCacheWrite: number | null;
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

/** Min over the values; null when empty (v7 §6.1 — min cost over priced attempts). */
function minOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  let m = values[0]!;
  for (const v of values) if (v < m) m = v;
  return m;
}

/** Max over the values; null when empty (v7 §6.1 — max cost over priced attempts). */
function maxOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  let m = values[0]!;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** Defensive numeric read: stored JSON may carry nulls or garbage — never NaN. */
function tokenValue(v: number | null): number {
  return v !== null && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Model key precedence (§1.2, unchanged): tokens.model → registry config.model
 * → "(configId)". v7 §7.1/§8: bare claude aliases in the resolved key
 * ("fable" from historical token models, "haiku" from config fallbacks) map to
 * the latest concrete family id so old and new rows group together; concrete
 * ids and the parenthesized fallback pass through untouched.
 */
function modelKey(
  row: AnalyticsSourceRow,
  registry: Registry,
  aliasMap: Record<string, string>,
): string {
  let key: string | null = null;
  if (row.tokenModel && row.tokenModel.trim().length > 0) {
    key = row.tokenModel;
  } else {
    const configModel = registry.configs.get(row.configId)?.model;
    if (configModel && configModel.length > 0) key = configModel;
  }
  if (key === null) return `(${row.configId})`;
  return resolveClaudeAlias(key, aliasMap) ?? key;
}

/**
 * Harness group key (v7 §7.1, frozen): the registry provider of the row's
 * configId; when the config left the catalog, the configId prefix before the
 * first "-" ("claude-fable" → "claude"); final fallback "(unknown)".
 */
function harnessKey(configId: string, registry: Registry): string {
  const provider = registry.configs.get(configId)?.provider;
  if (provider) return provider;
  const prefix = configId.split("-")[0] ?? "";
  return prefix.length > 0 ? prefix : "(unknown)";
}

/**
 * Model vendor (v7 §7.1, frozen rule — server-side only, the UI receives it):
 *   1. parenthesized config fallback key "(configId)" → "(unknown)";
 *   2. key contains "/" → first path segment lowercased ("deepseek/x" →
 *      "deepseek"); a leading "openrouter/" routing prefix (evals config
 *      convention, not a vendor) is skipped so harness-priced
 *      ("openrouter/deepseek/…") and recomputed ("deepseek/…") rows agree;
 *   3. starts with "claude" → "anthropic";
 *   4. /^(gpt|o\d|codex|davinci)/ → "openai";
 *   5. starts with "gemini" → "google";
 *   6. else "(unknown)".
 */
export function vendorOfModelKey(key: string): string {
  if (key.startsWith("(") && key.endsWith(")")) return "(unknown)";
  const lower = key.trim().toLowerCase();
  if (lower.includes("/")) {
    const segments = lower.split("/").filter((s) => s.length > 0);
    const first = segments[0] === "openrouter" && segments.length > 1 ? segments[1] : segments[0];
    return first && first.length > 0 ? first : "(unknown)";
  }
  if (lower.startsWith("claude")) return "anthropic";
  if (/^(gpt|o\d|codex|davinci)/.test(lower)) return "openai";
  if (lower.startsWith("gemini")) return "google";
  return "(unknown)";
}

/** Shared per-group metric accumulation (cells, per-run points, models, rollups). */
interface MetricAcc {
  attempts: number;
  graded: number;
  passed: number;
  errors: number;
  costs: number[];
  judgeCosts: number[];
  durations: number[];
  scores: number[];
  /** Token sums over token-bearing attempts (v7 §11). */
  tokenAttempts: number;
  tokenInput: number;
  tokenOutput: number;
  tokenCacheRead: number;
  tokenCacheWrite: number;
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
    tokenAttempts: 0,
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheWrite: 0,
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
  // v7 §6.1: an attempt is token-bearing iff any token field is > 0 — all-zero
  // tokens_json blobs (the pre-v7 harness-priced gap) contribute nothing.
  const input = tokenValue(row.tokenInput);
  const output = tokenValue(row.tokenOutput);
  const cacheRead = tokenValue(row.tokenCacheRead);
  const cacheWrite = tokenValue(row.tokenCacheWrite);
  if (input + output + cacheRead + cacheWrite > 0) {
    acc.tokenAttempts += 1;
    acc.tokenInput += input;
    acc.tokenOutput += output;
    acc.tokenCacheRead += cacheRead;
    acc.tokenCacheWrite += cacheWrite;
  }
}

/** AnalyticsTokenSums for a finished group; null when no token-bearing attempts (v7 §6.1). */
function tokenSums(acc: MetricAcc): AnalyticsTokenSums | null {
  if (acc.tokenAttempts === 0) return null;
  const totalTokens = acc.tokenInput + acc.tokenOutput + acc.tokenCacheRead + acc.tokenCacheWrite;
  return {
    tokenAttempts: acc.tokenAttempts,
    inputTokens: acc.tokenInput,
    outputTokens: acc.tokenOutput,
    cacheReadTokens: acc.tokenCacheRead,
    cacheWriteTokens: acc.tokenCacheWrite,
    totalTokens,
    avgTotalTokens: ratio(totalTokens, acc.tokenAttempts),
  };
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
  /** Model vendor (v7 §7.1) — computed once from the resolved key. */
  vendor: string;
  providers: Set<string>;
  /** Contributing harness keys (v7 §7.2 scatter), first-seen order. */
  harnesses: Set<string>;
  configIds: Set<string>;
  runIds: Set<string>;
  /** Runs with ≥1 priced attempt (avgCostPerRun denominator). */
  pricedRunIds: Set<string>;
  /** Σ over attempts having BOTH costUsd and durationMs ($/minute subset). */
  pairedCostUsd: number;
  pairedDurationMs: number;
}

/** Rollup accumulator keyed by harness or vendor (v7 §7.2). */
interface GroupAcc extends MetricAcc {
  group: string;
  models: Set<string>;
  configIds: Set<string>;
  runIds: Set<string>;
}

function accumulateGroup(
  groups: Map<string, GroupAcc>,
  group: string,
  row: AnalyticsSourceRow,
  model: string,
): void {
  let acc = groups.get(group);
  if (!acc) {
    acc = {
      ...newMetricAcc(),
      group,
      models: new Set(),
      configIds: new Set(),
      runIds: new Set(),
    };
    groups.set(group, acc);
  }
  accumulate(acc, row);
  acc.models.add(model);
  acc.configIds.add(row.configId);
  acc.runIds.add(row.runId);
}

/** GroupAcc → AnalyticsGroupRollup (same MetricAcc rules as models — v7 §7.2). */
function finishGroup(g: GroupAcc): AnalyticsGroupRollup {
  const totalCostUsd = g.costs.length ? sum(g.costs) : null;
  return {
    group: g.group,
    models: [...g.models],
    configIds: [...g.configIds],
    runs: g.runIds.size,
    attempts: g.attempts,
    graded: g.graded,
    passed: g.passed,
    errors: g.errors,
    passRate: ratio(g.passed, g.graded),
    avgScore: mean(g.scores),
    pricedAttempts: g.costs.length,
    totalCostUsd,
    avgCostPerAttempt: totalCostUsd === null ? null : ratio(totalCostUsd, g.costs.length),
    minCostUsd: minOrNull(g.costs),
    maxCostUsd: maxOrNull(g.costs),
    avgDurationMs: mean(g.durations),
    tokens: tokenSums(g),
  };
}

/** Attempts desc, then group key — deterministic for a given input (v7 §7.2). */
function sortGroups(groups: Map<string, GroupAcc>): AnalyticsGroupRollup[] {
  return [...groups.values()]
    .map(finishGroup)
    .sort((a, b) => b.attempts - a.attempts || a.group.localeCompare(b.group));
}

export function buildAnalytics(
  sourceRows: AnalyticsSourceRow[],
  registry: Registry,
  /** v7 §8 claude alias map (getClaudeAliasMap()); {} degrades to raw keys. */
  aliasMap: Record<string, string> = {},
  /**
   * v7.6 §C3 (frozen): row kept iff (configIds unset/empty OR row.configId ∈
   * configIds) AND (harnesses unset/empty OR harnessKey(row.configId) ∈
   * harnesses). The §7.1 harnessKey rule means removed-config history filters
   * correctly via the configId-prefix fallback.
   */
  filter?: AnalyticsFilter | null,
): AnalyticsResponse {
  // filterOptions over ALL rows BEFORE filtering (first-seen order) — the bar
  // keeps every option visible while a filter is active.
  const filterOptions: AnalyticsFilterOptions = { harnesses: [], configIds: [] };
  for (const row of sourceRows) {
    const harness = harnessKey(row.configId, registry);
    if (!filterOptions.harnesses.includes(harness)) filterOptions.harnesses.push(harness);
    if (!filterOptions.configIds.includes(row.configId)) filterOptions.configIds.push(row.configId);
  }

  const harnessSet =
    filter !== undefined && filter !== null && filter.harnesses.length > 0
      ? new Set(filter.harnesses)
      : null;
  const configSet =
    filter !== undefined && filter !== null && filter.configIds.length > 0
      ? new Set(filter.configIds)
      : null;
  const rows =
    harnessSet === null && configSet === null
      ? sourceRows
      : sourceRows.filter(
          (row) =>
            (configSet === null || configSet.has(row.configId)) &&
            (harnessSet === null || harnessSet.has(harnessKey(row.configId, registry))),
        );
  // appliedFilter = the filter when any axis is non-empty, else null.
  const appliedFilter = harnessSet !== null || configSet !== null ? (filter ?? null) : null;

  const scenarioIds: string[] = [];
  const configIds: string[] = [];
  const cells = new Map<string, CellAcc>();
  const models = new Map<string, ModelAcc>();
  const harnessGroups = new Map<string, GroupAcc>();
  const vendorGroups = new Map<string, GroupAcc>();

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
    const model = modelKey(row, registry, aliasMap);
    const harness = harnessKey(row.configId, registry);
    let modelAcc = models.get(model);
    if (!modelAcc) {
      modelAcc = {
        ...newMetricAcc(),
        model,
        vendor: vendorOfModelKey(model),
        providers: new Set(),
        harnesses: new Set(),
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
    modelAcc.harnesses.add(harness);
    modelAcc.configIds.add(row.configId);
    modelAcc.runIds.add(row.runId);
    if (row.costUsd !== null) modelAcc.pricedRunIds.add(row.runId);
    if (row.costUsd !== null && row.durationMs !== null) {
      modelAcc.pairedCostUsd += row.costUsd;
      modelAcc.pairedDurationMs += row.durationMs;
    }

    // ---- harness / vendor rollups (v7 §7) ----
    accumulateGroup(harnessGroups, harness, row, model);
    accumulateGroup(vendorGroups, modelAcc.vendor, row, model);
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
      minCostUsd: minOrNull(cell.costs),
      maxCostUsd: maxOrNull(cell.costs),
      tokens: tokenSums(cell),
    };
  });

  // One pass over the model accs builds BOTH the rollup and its scatter point
  // (v7 §7.2: one point per model key; same sort as models — attempts desc).
  const modelEntries = [...models.values()]
    .map((m) => {
      const totalCostUsd = m.costs.length ? sum(m.costs) : null;
      const tokens = tokenSums(m);
      const avgCostPerAttempt = totalCostUsd === null ? null : ratio(totalCostUsd, m.costs.length);
      const rollup: AnalyticsModel = {
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
        avgCostPerAttempt,
        avgCostPerRun: totalCostUsd === null ? null : ratio(totalCostUsd, m.pricedRunIds.size),
        // Null when the both-fields subset is empty OR Σduration is 0 (§1.3).
        costPerMinute:
          m.pairedDurationMs > 0 ? ratio(m.pairedCostUsd, m.pairedDurationMs / 60_000) : null,
        avgDurationMs: mean(m.durations),
        minCostUsd: minOrNull(m.costs),
        maxCostUsd: maxOrNull(m.costs),
        vendor: m.vendor,
        tokens,
      };
      const point: AnalyticsScatterPoint = {
        model: m.model,
        vendor: m.vendor,
        harnesses: [...m.harnesses],
        attempts: m.attempts,
        graded: m.graded,
        passRate: rollup.passRate,
        avgScore: rollup.avgScore,
        avgCostUsd: avgCostPerAttempt,
        avgDurationMs: rollup.avgDurationMs,
        avgTotalTokens: tokens?.avgTotalTokens ?? null,
        totalTokens: tokens?.totalTokens ?? 0,
      };
      return { rollup, point };
    })
    .sort(
      (a, b) =>
        b.rollup.attempts - a.rollup.attempts || a.rollup.model.localeCompare(b.rollup.model),
    );
  const modelRollups = modelEntries.map((e) => e.rollup);
  const scatter = modelEntries.map((e) => e.point);

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
          minCostUsd: minOrNull(p.costs),
          maxCostUsd: maxOrNull(p.costs),
          tokens: tokenSums(p),
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
    harnesses: sortGroups(harnessGroups),
    vendors: sortGroups(vendorGroups),
    scatter,
    filterOptions,
    appliedFilter,
  };
}
