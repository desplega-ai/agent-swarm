/**
 * Suite analytics: the numbers behind "which setup is best" (Phase 4 of the
 * swarm-evals plan). Pure functions over the joined attempts x runs rows that
 * `analytics-source.ts` reads; nothing here touches the DB or the network.
 *
 * Every function looks at ONE suite version (`suiteVersion`), so a config's
 * numbers never mix scenario versions. Rules shared by all views:
 *
 *   - A row counts only when `row.suiteVersion === suiteVersion`. `cancelled`
 *     attempts (dead run, cost cap) are dropped; `error` attempts (harness
 *     crashes, judge flakes) are counted in `errors` and never scored; only
 *     `passed` / `failed` attempts are "graded" and feed a score.
 *   - The suite's scenarios are fixed, so a config's score is the mean of its
 *     per-scenario means (each scenario counts once) and its CI comes from a
 *     stratified bootstrap over the attempts INSIDE each scenario. Cost is
 *     aggregated the same way; agent time is a pooled median.
 *   - A config "ran the full suite" when every expected scenario has a graded
 *     attempt. Only those are ranked or count toward a pooled frontier; the rest
 *     are still listed, with `rank: null`.
 *   - A cell (config x scenario) with fewer than `LOW_N` graded attempts is
 *     `lowN`. A `lowN` config never sits on the pooled frontier: with 1-2
 *     attempts per scenario, "best" is noise.
 *   - Ratios are null, never NaN, on an empty denominator.
 *
 * pass@1 is the mean per-scenario pass rate. pass^k is the unbiased estimate
 * that k attempts on the same scenario ALL pass (`passPowK`), averaged over the
 * scenarios that have at least k graded attempts.
 */

import { SUITE_SCENARIO_VERSIONS, SUITE_VERSION } from "../../scenarios/suite.ts";
import type { Registry } from "../runner/index.ts";
import {
  bootstrapCI,
  bootstrapRankSpread,
  type Interval,
  pairedBootstrapDiffCI,
  passAtK,
  passPowK,
  stratifiedBootstrapCI,
} from "../stats.ts";
import type { AnalyticsFilter } from "../types.ts";
import {
  type AnalyticsSourceRow,
  effortKey,
  filterRows,
  harnessKey,
  modelKey,
  vendorOfModelKey,
} from "./analytics.ts";

/** A config x scenario cell with fewer graded attempts than this is flagged `lowN`. */
export const LOW_N = 3;
/** Default k for the leaderboard's pass^k column (the nightly runs 3 repeats). */
export const DEFAULT_PASS_K = 3;
/** Largest k the API accepts. */
export const MAX_PASS_K = 10;
/** A paired comparison needs this many shared scenarios before it reports a CI. */
export const MIN_COMPARE_SCENARIOS = 5;
/** Most recent runs kept in a config's reliability trend. */
export const TREND_LIMIT = 60;

const TREND_BOOTSTRAP_ITERS = 1000;
const EPS = 1e-9;

// ---- inputs and response types ----

export interface SuiteAnalyticsInput {
  /** attempts x runs rows for any mix of suites; rows outside `suiteVersion` are ignored. */
  rows: AnalyticsSourceRow[];
  registry: Registry;
  /** Claude alias map (`getClaudeAliasMap()`); `{}` leaves bare aliases ungrouped. */
  aliasMap?: Record<string, string>;
  suiteVersion: string;
  /** Same harness / config / effort narrowing as `/api/analytics`. */
  filter?: AnalyticsFilter | null;
  /** Override the scenario set that defines "the full suite" (tests). */
  expectedScenarioIds?: string[];
  generatedAt?: string;
}

export interface CiBounds {
  lo: number;
  hi: number;
}

export interface Coverage {
  covered: number;
  expected: number;
}

export interface FrontierPoint {
  configId: string;
  harness: string;
  resolvedModel: string;
  vendor: string;
  /** Mean of per-scenario mean scores. */
  score: number;
  scoreCi: CiBounds;
  /** Mean agent $ per attempt over the scenarios that have priced attempts; null when none. */
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  /** Median agent time (timings.tasksMs, sandbox boot and seeding excluded) over graded attempts. */
  medianAgentMs: number | null;
  /** Graded attempts behind the point. */
  attempts: number;
  scenarios: Coverage;
  fullCoverage: boolean;
  lowN: boolean;
  /** Every covered scenario has a priced attempt; the cost axis is comparable only then. */
  costComplete: boolean;
  /** Every covered scenario has an agent-time reading; the time axis is comparable only then. */
  timeComplete: boolean;
}

export interface ScenarioFrontierPoint {
  configId: string;
  harness: string;
  resolvedModel: string;
  score: number;
  scoreCi: CiBounds;
  passRate: number | null;
  avgCostUsd: number | null;
  medianAgentMs: number | null;
  /** Graded attempts. */
  attempts: number;
  lowN: boolean;
}

export interface FrontierIds {
  /** Score vs $/attempt: configs no other config beats on both axes. */
  cost: string[];
  /** Score vs agent time. */
  time: string[];
}

export interface FrontierResponse {
  suiteVersion: string;
  generatedAt: string;
  expectedScenarios: string[];
  lowNThreshold: number;
  /**
   * `ok`: at least one trusted point. `low-n`: full-coverage configs exist but every one is
   * `lowN`, so no frontier is drawn. `no-full-coverage`: no config ran the whole suite.
   * `empty`: no graded attempts in this suite.
   */
  status: "ok" | "low-n" | "no-full-coverage" | "empty";
  warnings: string[];
  /** Every config with a graded attempt, best score first. */
  points: FrontierPoint[];
  /** Pooled frontier over full-coverage, non-lowN points. Ids ordered by ascending x. */
  frontier: FrontierIds;
  /** Per-scenario frontiers; partial coverage is accepted, `lowN` cells stay off the frontier. */
  scenarios: { scenarioId: string; points: ScenarioFrontierPoint[]; frontier: FrontierIds }[];
}

export interface LeaderboardRow {
  /** 1 = best among the ranked rows of its track; ties share a rank. Null when not ranked. */
  rank: number | null;
  /** 95% bootstrap range of the rank across resamples. Null when not ranked. */
  rankSpread: { lo: number; hi: number } | null;
  configId: string;
  harness: string;
  /** Most frequent concrete model the config's graded attempts ran on. */
  resolvedModel: string;
  /** Every concrete model seen (an alias config can span several), most frequent first. */
  resolvedModels: string[];
  vendor: string;
  /** Reasoning efforts seen (`default` = harness default). More than one means mixed efforts. */
  efforts: string[];
  score: number | null;
  scoreCi: CiBounds | null;
  /** Mean per-scenario pass rate. */
  passAt1: number | null;
  /** Unbiased pass^k at the response's `k`, over scenarios with at least k graded attempts. */
  passPowK: number | null;
  /** How many scenarios passPowK averages over (fewer than `scenarios.covered` = partial). */
  passPowKScenarios: number;
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  medianAgentMs: number | null;
  /** Mean total tokens per token-bearing graded attempt. */
  avgTotalTokens: number | null;
  attempts: number;
  errors: number;
  scenarios: Coverage;
  fullCoverage: boolean;
  lowN: boolean;
  suiteVersion: string;
}

export interface LeaderboardResponse {
  suiteVersion: string;
  generatedAt: string;
  k: number;
  expectedScenarios: string[];
  tracks: {
    /** One group per harness: every model on that harness, ranked among themselves. */
    fixedHarness: { harness: string; rows: LeaderboardRow[] }[];
    /** Each model on the harness that scores it best, ranked among the picks. */
    bestHarnessPerModel: { rows: LeaderboardRow[] };
  };
}

export interface HeatmapCell {
  scenarioId: string;
  configId: string;
  graded: number;
  passed: number;
  errors: number;
  passRate: number | null;
  avgScore: number | null;
  lowN: boolean;
}

export interface HeatmapAnyRow {
  scenarioId: string;
  graded: number;
  passed: number;
  /** Pooled over every config's graded attempts. */
  passRate: number | null;
  configs: number;
  /** Configs with at least one passing attempt. 0 with configs > 0 = broken or too hard. */
  configsPassing: number;
}

export interface HeatmapResponse {
  suiteVersion: string;
  generatedAt: string;
  lowNThreshold: number;
  scenarioIds: string[];
  /** Full-coverage configs first, then by score. */
  configIds: string[];
  cells: HeatmapCell[];
  anyConfig: HeatmapAnyRow[];
}

export interface ReliabilityPoint {
  k: number;
  /** Chance all k attempts pass. */
  passPowK: number | null;
  /** Chance at least one of k passes. */
  passAtK: number | null;
  /** Scenarios with at least k graded attempts. */
  scenarios: number;
}

export interface TrendPoint {
  runId: string;
  runName: string | null;
  createdAt: string;
  /** Scenarios the run covered for this config. */
  scenarios: number;
  attempts: number;
  score: number | null;
  scoreCi: CiBounds | null;
  passRate: number | null;
}

export interface ReliabilityConfig {
  configId: string;
  harness: string;
  resolvedModel: string;
  fullCoverage: boolean;
  lowN: boolean;
  attempts: number;
  passAt1: number | null;
  curve: ReliabilityPoint[];
  /** Oldest to newest, at most TREND_LIMIT runs. */
  trend: TrendPoint[];
}

export interface ReliabilityResponse {
  suiteVersion: string;
  generatedAt: string;
  maxK: number;
  configs: ReliabilityConfig[];
}

export interface CompareSide {
  configId: string;
  harness: string;
  resolvedModel: string;
  score: number | null;
  scoreCi: CiBounds | null;
  passAt1: number | null;
  attempts: number;
  fullCoverage: boolean;
  lowN: boolean;
}

export interface CompareScenarioRow {
  scenarioId: string;
  a: { attempts: number; score: number | null; passRate: number | null };
  b: { attempts: number; score: number | null; passRate: number | null };
  /** a - b; null unless both sides have a value. */
  scoreDiff: number | null;
  passRateDiff: number | null;
}

export interface PairedDiff {
  /** Mean of the per-scenario differences (a - b). */
  diff: number | null;
  /** 95% paired bootstrap CI over scenarios; null below `minScenarios`. */
  ci: CiBounds | null;
  /** The whole CI is on one side of 0. Always false without a CI. */
  significant: boolean;
  scenarios: number;
}

export interface CompareResponse {
  suiteVersion: string;
  generatedAt: string;
  a: CompareSide;
  b: CompareSide;
  /** Shared scenarios needed before a CI is reported. */
  minScenarios: number;
  /** False when the pair cannot support a comparison; `reason` says why. */
  comparable: boolean;
  reason: string | null;
  /** Scenarios both sides have graded attempts on. */
  scenarios: CompareScenarioRow[];
  onlyA: string[];
  onlyB: string[];
  score: PairedDiff & { wins: number; losses: number; ties: number };
  passRate: PairedDiff;
}

// ---- aggregation ----

interface RunCell {
  scores: number[];
  graded: number;
  passed: number;
}

interface Cell {
  scenarioId: string;
  graded: number;
  passed: number;
  errors: number;
  scores: number[];
  costs: number[];
  judgeCosts: number[];
  agentTimes: number[];
  runs: Map<string, RunCell>;
}

interface ConfigAgg {
  configId: string;
  harness: string;
  cells: Map<string, Cell>;
  models: Map<string, number>;
  efforts: Set<string>;
  runMeta: Map<string, { name: string | null; createdAt: string }>;
  graded: number;
  errors: number;
  agentTimes: number[];
  tokenAttempts: number;
  tokenTotal: number;
}

interface ConfigStats {
  agg: ConfigAgg;
  /** Expected scenarios that have a graded attempt, in expected order. */
  covered: string[];
  /** Score arrays per covered scenario (empty scenarios dropped). */
  strata: number[][];
  fullCoverage: boolean;
  minCellN: number;
  lowN: boolean;
  score: number | null;
  scoreCi: CiBounds | null;
  passAt1: number | null;
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  costComplete: boolean;
  timeComplete: boolean;
  medianAgentMs: number | null;
  avgTotalTokens: number | null;
  resolvedModel: string;
  resolvedModels: string[];
}

interface Prepared {
  suiteVersion: string;
  generatedAt: string;
  registry: Registry;
  expected: string[];
  configs: ConfigStats[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = values.reduce((a, b) => a + b, 0) / values.length;
  return Number.isFinite(v) ? v : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Number.isFinite(v) ? v : null;
}

/** Mean of the non-null values; null when there are none. */
function macro(values: (number | null)[]): number | null {
  return mean(values.filter((v): v is number => v !== null));
}

function ci(interval: Interval): CiBounds {
  return { lo: interval.lo, hi: interval.hi };
}

/** The scenario set that defines "the full suite" for a suite version. */
function expectedScenarios(
  suiteVersion: string,
  rows: AnalyticsSourceRow[],
  override?: string[],
): string[] {
  if (override) return [...override];
  if (suiteVersion === SUITE_VERSION) return Object.keys(SUITE_SCENARIO_VERSIONS);
  const seen: string[] = [];
  for (const row of rows) if (!seen.includes(row.scenarioId)) seen.push(row.scenarioId);
  return seen;
}

function newCell(scenarioId: string): Cell {
  return {
    scenarioId,
    graded: 0,
    passed: 0,
    errors: 0,
    scores: [],
    costs: [],
    judgeCosts: [],
    agentTimes: [],
    runs: new Map(),
  };
}

function prepare(input: SuiteAnalyticsInput): Prepared {
  const { registry, suiteVersion } = input;
  const aliasMap = input.aliasMap ?? {};
  // Suite scope first, then the caller's narrowing. Cancelled attempts never ran to a verdict.
  const inSuite = input.rows.filter(
    (row) => row.suiteVersion === suiteVersion && row.exclusion !== "cancelled",
  );
  const rows = filterRows(inSuite, registry, input.filter);
  const expected = expectedScenarios(suiteVersion, inSuite, input.expectedScenarioIds);
  const expectedSet = new Set(expected);

  const aggs = new Map<string, ConfigAgg>();
  for (const row of rows) {
    if (!expectedSet.has(row.scenarioId)) continue;
    let agg = aggs.get(row.configId);
    if (!agg) {
      agg = {
        configId: row.configId,
        harness: harnessKey(row.configId, registry),
        cells: new Map(),
        models: new Map(),
        efforts: new Set(),
        runMeta: new Map(),
        graded: 0,
        errors: 0,
        agentTimes: [],
        tokenAttempts: 0,
        tokenTotal: 0,
      };
      aggs.set(row.configId, agg);
    }
    let cell = agg.cells.get(row.scenarioId);
    if (!cell) {
      cell = newCell(row.scenarioId);
      agg.cells.set(row.scenarioId, cell);
    }
    if (row.status === "error") {
      cell.errors += 1;
      agg.errors += 1;
      continue;
    }
    if (row.status !== "passed" && row.status !== "failed") continue;
    cell.graded += 1;
    agg.graded += 1;
    if (row.status === "passed") cell.passed += 1;
    if (row.score !== null && Number.isFinite(row.score)) cell.scores.push(row.score);
    if (row.costUsd !== null) cell.costs.push(row.costUsd);
    if (row.judgeCostUsd !== null) cell.judgeCosts.push(row.judgeCostUsd);
    if (row.agentMs !== null && row.agentMs !== undefined && Number.isFinite(row.agentMs)) {
      cell.agentTimes.push(row.agentMs);
      agg.agentTimes.push(row.agentMs);
    }
    const tokens =
      (row.tokenInput ?? 0) +
      (row.tokenOutput ?? 0) +
      (row.tokenCacheRead ?? 0) +
      (row.tokenCacheWrite ?? 0);
    if (Number.isFinite(tokens) && tokens > 0) {
      agg.tokenAttempts += 1;
      agg.tokenTotal += tokens;
    }
    const model = modelKey(row, registry, aliasMap);
    agg.models.set(model, (agg.models.get(model) ?? 0) + 1);
    agg.efforts.add(effortKey(row));
    let runCell = cell.runs.get(row.runId);
    if (!runCell) {
      runCell = { scores: [], graded: 0, passed: 0 };
      cell.runs.set(row.runId, runCell);
    }
    runCell.graded += 1;
    if (row.status === "passed") runCell.passed += 1;
    if (row.score !== null && Number.isFinite(row.score)) runCell.scores.push(row.score);
    if (!agg.runMeta.has(row.runId)) {
      agg.runMeta.set(row.runId, { name: row.runName, createdAt: row.runCreatedAt });
    }
  }

  const configs = [...aggs.values()]
    .filter((agg) => agg.graded > 0)
    .map((agg) => finishConfig(agg, expected));
  return {
    suiteVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    registry,
    expected,
    configs,
  };
}

function finishConfig(agg: ConfigAgg, expected: string[]): ConfigStats {
  const cells = expected
    .map((id) => agg.cells.get(id))
    .filter((c): c is Cell => c !== undefined && c.graded > 0);
  const covered = cells.map((c) => c.scenarioId);
  const strata = cells.map((c) => c.scores).filter((s) => s.length > 0);
  const interval = stratifiedBootstrapCI(strata);
  const minCellN = cells.length === 0 ? 0 : Math.min(...cells.map((c) => c.graded));
  const models = [...agg.models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const pricedCells = cells.filter((c) => c.costs.length > 0);
  return {
    agg,
    covered,
    strata,
    fullCoverage: expected.length > 0 && covered.length === expected.length,
    minCellN,
    lowN: cells.length === 0 || minCellN < LOW_N,
    score: interval.mean,
    scoreCi: interval.mean === null ? null : ci(interval),
    passAt1: macro(cells.map((c) => (c.graded > 0 ? c.passed / c.graded : null))),
    avgCostUsd: macro(pricedCells.map((c) => mean(c.costs))),
    avgJudgeCostUsd: macro(cells.map((c) => mean(c.judgeCosts))),
    costComplete: cells.length > 0 && pricedCells.length === cells.length,
    timeComplete: cells.length > 0 && cells.every((c) => c.agentTimes.length > 0),
    medianAgentMs: median(agg.agentTimes),
    avgTotalTokens: agg.tokenAttempts > 0 ? agg.tokenTotal / agg.tokenAttempts : null,
    resolvedModel: models[0]?.[0] ?? `(${agg.configId})`,
    resolvedModels: models.map(([m]) => m),
  };
}

function coverage(s: ConfigStats, expected: string[]): Coverage {
  return { covered: s.covered.length, expected: expected.length };
}

/** Configs that can be ranked: full suite and a score. */
function rankable(s: ConfigStats): boolean {
  return s.fullCoverage && s.score !== null;
}

function byScoreDesc(a: ConfigStats, b: ConfigStats): number {
  return (
    (b.score ?? -1) - (a.score ?? -1) ||
    (b.passAt1 ?? -1) - (a.passAt1 ?? -1) ||
    a.agg.configId.localeCompare(b.agg.configId)
  );
}

// ---- frontier ----

/** Ids of the points no other point beats on both axes (higher y, lower x), ascending x. */
function paretoIds(points: { id: string; x: number; y: number }[]): string[] {
  const front = points.filter(
    (p) =>
      !points.some(
        (q) =>
          q !== p && q.y >= p.y - EPS && q.x <= p.x + EPS && (q.y > p.y + EPS || q.x < p.x - EPS),
      ),
  );
  return front.sort((a, b) => a.x - b.x || b.y - a.y || a.id.localeCompare(b.id)).map((p) => p.id);
}

export function buildFrontier(input: SuiteAnalyticsInput): FrontierResponse {
  const p = prepare(input);
  const points: FrontierPoint[] = p.configs
    .filter((s) => s.score !== null && s.scoreCi !== null)
    .sort(byScoreDesc)
    .map((s) => ({
      configId: s.agg.configId,
      harness: s.agg.harness,
      resolvedModel: s.resolvedModel,
      vendor: vendorOfModelKey(s.resolvedModel),
      score: s.score as number,
      scoreCi: s.scoreCi as CiBounds,
      avgCostUsd: s.avgCostUsd,
      avgJudgeCostUsd: s.avgJudgeCostUsd,
      medianAgentMs: s.medianAgentMs,
      attempts: s.agg.graded,
      scenarios: coverage(s, p.expected),
      fullCoverage: s.fullCoverage,
      lowN: s.lowN,
      costComplete: s.costComplete,
      timeComplete: s.timeComplete,
    }));

  const full = points.filter((pt) => pt.fullCoverage);
  const trusted = full.filter((pt) => !pt.lowN);
  const frontier: FrontierIds = {
    cost: paretoIds(
      trusted
        .filter((pt) => pt.costComplete && pt.avgCostUsd !== null)
        .map((pt) => ({ id: pt.configId, x: pt.avgCostUsd as number, y: pt.score })),
    ),
    time: paretoIds(
      trusted
        .filter((pt) => pt.timeComplete && pt.medianAgentMs !== null)
        .map((pt) => ({ id: pt.configId, x: pt.medianAgentMs as number, y: pt.score })),
    ),
  };

  const warnings: string[] = [];
  let status: FrontierResponse["status"] = "ok";
  if (points.length === 0) status = "empty";
  else if (full.length === 0) status = "no-full-coverage";
  else if (trusted.length === 0) status = "low-n";
  if (status === "no-full-coverage") {
    warnings.push(
      `No config has a graded attempt in every one of the ${p.expected.length} scenarios of suite ${p.suiteVersion}, so no pooled frontier is drawn.`,
    );
  }
  if (status === "low-n") {
    warnings.push(
      `Every full-suite config has a scenario with fewer than ${LOW_N} graded attempts, so no pooled frontier is drawn.`,
    );
  }
  const partial = points.length - full.length;
  if (partial > 0 && status !== "no-full-coverage") {
    warnings.push(
      `${partial} config(s) did not run the full suite and are left off the pooled frontier.`,
    );
  }
  const lowNFull = full.length - trusted.length;
  if (lowNFull > 0 && status === "ok") {
    warnings.push(
      `${lowNFull} full-suite config(s) have a cell under ${LOW_N} attempts and are left off the pooled frontier.`,
    );
  }

  const scenarios = p.expected.map((scenarioId) => {
    const scenarioPoints: ScenarioFrontierPoint[] = [];
    for (const s of p.configs) {
      const cell = s.agg.cells.get(scenarioId);
      if (!cell || cell.graded === 0 || cell.scores.length === 0) continue;
      const cellScore = mean(cell.scores) as number;
      scenarioPoints.push({
        configId: s.agg.configId,
        harness: s.agg.harness,
        resolvedModel: s.resolvedModel,
        score: cellScore,
        scoreCi: ci(bootstrapCI(cell.scores)),
        passRate: cell.passed / cell.graded,
        avgCostUsd: mean(cell.costs),
        medianAgentMs: median(cell.agentTimes),
        attempts: cell.graded,
        lowN: cell.graded < LOW_N,
      });
    }
    scenarioPoints.sort((a, b) => b.score - a.score || a.configId.localeCompare(b.configId));
    const ok = scenarioPoints.filter((pt) => !pt.lowN);
    return {
      scenarioId,
      points: scenarioPoints,
      frontier: {
        cost: paretoIds(
          ok
            .filter((pt) => pt.avgCostUsd !== null)
            .map((pt) => ({ id: pt.configId, x: pt.avgCostUsd as number, y: pt.score })),
        ),
        time: paretoIds(
          ok
            .filter((pt) => pt.medianAgentMs !== null)
            .map((pt) => ({ id: pt.configId, x: pt.medianAgentMs as number, y: pt.score })),
        ),
      },
    };
  });

  return {
    suiteVersion: p.suiteVersion,
    generatedAt: p.generatedAt,
    expectedScenarios: p.expected,
    lowNThreshold: LOW_N,
    status,
    warnings,
    points,
    frontier,
    scenarios,
  };
}

// ---- leaderboard ----

/** Macro pass^k: mean over covered scenarios with at least k graded attempts. */
function macroPassPowK(s: ConfigStats, k: number): { value: number | null; scenarios: number } {
  const values: number[] = [];
  for (const id of s.covered) {
    const cell = s.agg.cells.get(id);
    const v = cell ? passPowK(cell.passed, cell.graded, k) : null;
    if (v !== null) values.push(v);
  }
  return { value: mean(values), scenarios: values.length };
}

function macroPassAtK(s: ConfigStats, k: number): number | null {
  const values: number[] = [];
  for (const id of s.covered) {
    const cell = s.agg.cells.get(id);
    const v = cell ? passAtK(cell.passed, cell.graded, k) : null;
    if (v !== null) values.push(v);
  }
  return mean(values);
}

/** Competition rank (1, 2, 2, 4) and bootstrap rank spread for the rankable configs of one list. */
function rankAmong(
  list: ConfigStats[],
): Map<string, { rank: number; spread: { lo: number; hi: number } }> {
  const ranked = list.filter(rankable).sort(byScoreDesc);
  const spreads = bootstrapRankSpread(ranked.map((s) => s.strata));
  const out = new Map<string, { rank: number; spread: { lo: number; hi: number } }>();
  let prevScore: number | null = null;
  let prevRank = 0;
  ranked.forEach((s, i) => {
    const rank =
      prevScore !== null && Math.abs((s.score as number) - prevScore) < EPS ? prevRank : i + 1;
    prevScore = s.score as number;
    prevRank = rank;
    const spread = spreads[i];
    out.set(s.agg.configId, {
      rank,
      spread: spread ? { lo: spread.lo, hi: spread.hi } : { lo: rank, hi: rank },
    });
  });
  return out;
}

function toRow(
  s: ConfigStats,
  p: Prepared,
  k: number,
  placement: { rank: number; spread: { lo: number; hi: number } } | undefined,
): LeaderboardRow {
  const pk = macroPassPowK(s, k);
  return {
    rank: placement?.rank ?? null,
    rankSpread: placement?.spread ?? null,
    configId: s.agg.configId,
    harness: s.agg.harness,
    resolvedModel: s.resolvedModel,
    resolvedModels: s.resolvedModels,
    vendor: vendorOfModelKey(s.resolvedModel),
    efforts: [...s.agg.efforts].sort(),
    score: s.score,
    scoreCi: s.scoreCi,
    passAt1: s.passAt1,
    passPowK: pk.value,
    passPowKScenarios: pk.scenarios,
    avgCostUsd: s.avgCostUsd,
    avgJudgeCostUsd: s.avgJudgeCostUsd,
    medianAgentMs: s.medianAgentMs,
    avgTotalTokens: s.avgTotalTokens,
    attempts: s.agg.graded,
    errors: s.agg.errors,
    scenarios: coverage(s, p.expected),
    fullCoverage: s.fullCoverage,
    lowN: s.lowN,
    suiteVersion: p.suiteVersion,
  };
}

/** Ranked rows first (by rank), then the unranked by score. */
function rowsForList(list: ConfigStats[], p: Prepared, k: number): LeaderboardRow[] {
  const placed = rankAmong(list);
  return [...list]
    .sort((a, b) => {
      const ra = placed.get(a.agg.configId)?.rank;
      const rb = placed.get(b.agg.configId)?.rank;
      if (ra !== undefined && rb !== undefined) return ra - rb || byScoreDesc(a, b);
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return byScoreDesc(a, b);
    })
    .map((s) => toRow(s, p, k, placed.get(s.agg.configId)));
}

export function buildLeaderboard(
  input: SuiteAnalyticsInput,
  k: number = DEFAULT_PASS_K,
): LeaderboardResponse {
  const p = prepare(input);

  const byHarness = new Map<string, ConfigStats[]>();
  for (const s of p.configs) {
    const list = byHarness.get(s.agg.harness) ?? [];
    list.push(s);
    byHarness.set(s.agg.harness, list);
  }
  const fixedHarness = [...byHarness.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([harness, list]) => ({ harness, rows: rowsForList(list, p, k) }));

  // Best harness per model: a rankable config beats an unrankable one, then higher score.
  const byModel = new Map<string, ConfigStats[]>();
  for (const s of p.configs) {
    const list = byModel.get(s.resolvedModel) ?? [];
    list.push(s);
    byModel.set(s.resolvedModel, list);
  }
  const picks = [...byModel.values()].map(
    (list) =>
      [...list].sort(
        (a, b) => Number(rankable(b)) - Number(rankable(a)) || byScoreDesc(a, b),
      )[0] as ConfigStats,
  );

  return {
    suiteVersion: p.suiteVersion,
    generatedAt: p.generatedAt,
    k,
    expectedScenarios: p.expected,
    tracks: { fixedHarness, bestHarnessPerModel: { rows: rowsForList(picks, p, k) } },
  };
}

// ---- heatmap ----

export function buildHeatmap(input: SuiteAnalyticsInput): HeatmapResponse {
  const p = prepare(input);
  // Errors-only cells have no graded attempts; prepare() drops configs without any graded attempt,
  // so a cell here always belongs to a config with data.
  const configs = [...p.configs].sort(
    (a, b) => Number(b.fullCoverage) - Number(a.fullCoverage) || byScoreDesc(a, b),
  );
  const cells: HeatmapCell[] = [];
  const anyConfig: HeatmapAnyRow[] = [];
  for (const scenarioId of p.expected) {
    let graded = 0;
    let passed = 0;
    let withData = 0;
    let passing = 0;
    for (const s of configs) {
      const cell = s.agg.cells.get(scenarioId);
      if (!cell || (cell.graded === 0 && cell.errors === 0)) continue;
      cells.push({
        scenarioId,
        configId: s.agg.configId,
        graded: cell.graded,
        passed: cell.passed,
        errors: cell.errors,
        passRate: cell.graded > 0 ? cell.passed / cell.graded : null,
        avgScore: mean(cell.scores),
        lowN: cell.graded < LOW_N,
      });
      graded += cell.graded;
      passed += cell.passed;
      if (cell.graded > 0) withData += 1;
      if (cell.passed > 0) passing += 1;
    }
    anyConfig.push({
      scenarioId,
      graded,
      passed,
      passRate: graded > 0 ? passed / graded : null,
      configs: withData,
      configsPassing: passing,
    });
  }
  return {
    suiteVersion: p.suiteVersion,
    generatedAt: p.generatedAt,
    lowNThreshold: LOW_N,
    scenarioIds: p.expected,
    configIds: configs.map((s) => s.agg.configId),
    cells,
    anyConfig,
  };
}

// ---- reliability ----

function trendFor(s: ConfigStats, expected: string[]): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (const [runId, meta] of s.agg.runMeta) {
    const strata: number[][] = [];
    const passRates: number[] = [];
    let attempts = 0;
    let scenarios = 0;
    for (const id of expected) {
      const rc = s.agg.cells.get(id)?.runs.get(runId);
      if (!rc || rc.graded === 0) continue;
      scenarios += 1;
      attempts += rc.graded;
      passRates.push(rc.passed / rc.graded);
      if (rc.scores.length > 0) strata.push(rc.scores);
    }
    if (scenarios === 0) continue;
    const interval = stratifiedBootstrapCI(strata, { iters: TREND_BOOTSTRAP_ITERS });
    points.push({
      runId,
      runName: meta.name,
      createdAt: meta.createdAt,
      scenarios,
      attempts,
      score: interval.mean,
      scoreCi: interval.mean === null ? null : ci(interval),
      passRate: mean(passRates),
    });
  }
  points.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  return points.slice(-TREND_LIMIT);
}

export function buildReliability(
  input: SuiteAnalyticsInput,
  maxK: number = 5,
): ReliabilityResponse {
  const p = prepare(input);
  const configs = [...p.configs].sort(
    (a, b) => Number(b.fullCoverage) - Number(a.fullCoverage) || byScoreDesc(a, b),
  );
  return {
    suiteVersion: p.suiteVersion,
    generatedAt: p.generatedAt,
    maxK,
    configs: configs.map((s) => ({
      configId: s.agg.configId,
      harness: s.agg.harness,
      resolvedModel: s.resolvedModel,
      fullCoverage: s.fullCoverage,
      lowN: s.lowN,
      attempts: s.agg.graded,
      passAt1: s.passAt1,
      curve: Array.from({ length: maxK }, (_, i) => {
        const k = i + 1;
        const pk = macroPassPowK(s, k);
        return { k, passPowK: pk.value, passAtK: macroPassAtK(s, k), scenarios: pk.scenarios };
      }),
      trend: trendFor(s, p.expected),
    })),
  };
}

// ---- compare ----

function side(s: ConfigStats | undefined, configId: string, p: Prepared): CompareSide {
  return {
    configId,
    harness: s?.agg.harness ?? harnessKey(configId, p.registry),
    resolvedModel: s?.resolvedModel ?? `(${configId})`,
    score: s?.score ?? null,
    scoreCi: s?.scoreCi ?? null,
    passAt1: s?.passAt1 ?? null,
    attempts: s?.agg.graded ?? 0,
    fullCoverage: s?.fullCoverage ?? false,
    lowN: s?.lowN ?? true,
  };
}

function pairedDiff(a: number[], b: number[]): PairedDiff {
  if (a.length === 0) return { diff: null, ci: null, significant: false, scenarios: 0 };
  const d = pairedBootstrapDiffCI(a, b);
  if (a.length < MIN_COMPARE_SCENARIOS) {
    return { diff: d.diff, ci: null, significant: false, scenarios: a.length };
  }
  return {
    diff: d.diff,
    ci: { lo: d.lo, hi: d.hi },
    significant: d.significant,
    scenarios: a.length,
  };
}

/**
 * Paired comparison of two configs: per scenario both sides' mean score, then a
 * bootstrap over the SCENARIOS (each pair kept together), so a scenario that is
 * hard for both cancels out. Resampling attempts instead would treat repeats of
 * one scenario as independent evidence about the whole suite.
 */
export function buildCompare(
  input: SuiteAnalyticsInput,
  aId: string,
  bId: string,
): CompareResponse {
  const p = prepare(input);
  const a = p.configs.find((s) => s.agg.configId === aId);
  const b = p.configs.find((s) => s.agg.configId === bId);

  const rows: CompareScenarioRow[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const scoreA: number[] = [];
  const scoreB: number[] = [];
  const rateA: number[] = [];
  const rateB: number[] = [];
  for (const id of p.expected) {
    const ca = a?.agg.cells.get(id);
    const cb = b?.agg.cells.get(id);
    const hasA = ca !== undefined && ca.graded > 0;
    const hasB = cb !== undefined && cb.graded > 0;
    if (hasA && !hasB) onlyA.push(id);
    if (hasB && !hasA) onlyB.push(id);
    if (!hasA || !hasB) continue;
    const sa = mean(ca.scores);
    const sb = mean(cb.scores);
    const ra = ca.passed / ca.graded;
    const rb = cb.passed / cb.graded;
    rows.push({
      scenarioId: id,
      a: { attempts: ca.graded, score: sa, passRate: ra },
      b: { attempts: cb.graded, score: sb, passRate: rb },
      scoreDiff: sa !== null && sb !== null ? sa - sb : null,
      passRateDiff: ra - rb,
    });
    if (sa !== null && sb !== null) {
      scoreA.push(sa);
      scoreB.push(sb);
    }
    rateA.push(ra);
    rateB.push(rb);
  }

  let reason: string | null = null;
  if (!a || !b) {
    reason = `no graded attempts in suite ${p.suiteVersion} for ${[!a ? aId : null, !b ? bId : null]
      .filter((x) => x !== null)
      .join(" and ")}`;
  } else if (rows.length === 0) {
    reason = "the two configs share no scenario with graded attempts";
  } else if (rows.length < MIN_COMPARE_SCENARIOS) {
    reason = `only ${rows.length} shared scenario(s); a CI needs at least ${MIN_COMPARE_SCENARIOS}`;
  }

  const scoreDiff = pairedDiff(scoreA, scoreB);
  const diffs = rows.map((r) => r.scoreDiff).filter((d): d is number => d !== null);
  return {
    suiteVersion: p.suiteVersion,
    generatedAt: p.generatedAt,
    a: side(a, aId, p),
    b: side(b, bId, p),
    minScenarios: MIN_COMPARE_SCENARIOS,
    comparable: a !== undefined && b !== undefined && rows.length >= MIN_COMPARE_SCENARIOS,
    reason,
    scenarios: rows,
    onlyA,
    onlyB,
    score: {
      ...scoreDiff,
      wins: diffs.filter((d) => d > EPS).length,
      losses: diffs.filter((d) => d < -EPS).length,
      ties: diffs.filter((d) => Math.abs(d) <= EPS).length,
    },
    passRate: pairedDiff(rateA, rateB),
  };
}
