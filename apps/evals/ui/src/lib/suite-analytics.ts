/**
 * Client side of the `/api/analytics/{suites,frontier,leaderboard}` endpoints
 * (Phase 4 of the swarm-evals plan): response types mirrored from
 * `src/api/suite-analytics.ts`, plus the pure helpers the Leaderboard page
 * builds its chart and table from. No React here, so it is unit-tested from
 * `src/ui-suite-analytics.test.ts`.
 */

export interface CiBounds {
  lo: number;
  hi: number;
}

export interface Coverage {
  covered: number;
  expected: number;
}

export interface SuiteSummary {
  suiteVersion: string;
  attempts: number;
  runs: number;
  configs: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

export interface SuitesResponse {
  /** The suite the code manifest defines today. */
  current: string;
  suites: SuiteSummary[];
}

export interface FrontierPoint {
  configId: string;
  harness: string;
  resolvedModel: string;
  vendor: string;
  score: number;
  scoreCi: CiBounds;
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  medianAgentMs: number | null;
  attempts: number;
  scenarios: Coverage;
  fullCoverage: boolean;
  lowN: boolean;
  costComplete: boolean;
  timeComplete: boolean;
}

export interface FrontierIds {
  cost: string[];
  time: string[];
}

export type FrontierStatus = "ok" | "low-n" | "no-full-coverage" | "empty";

export interface FrontierResponse {
  suiteVersion: string;
  generatedAt: string;
  expectedScenarios: string[];
  lowNThreshold: number;
  status: FrontierStatus;
  warnings: string[];
  points: FrontierPoint[];
  frontier: FrontierIds;
}

export interface LeaderboardRow {
  rank: number | null;
  rankSpread: { lo: number; hi: number } | null;
  configId: string;
  harness: string;
  resolvedModel: string;
  resolvedModels: string[];
  vendor: string;
  efforts: string[];
  score: number | null;
  scoreCi: CiBounds | null;
  passAt1: number | null;
  passPowK: number | null;
  passPowKScenarios: number;
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  medianAgentMs: number | null;
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
    fixedHarness: { harness: string; rows: LeaderboardRow[] }[];
    bestHarnessPerModel: { rows: LeaderboardRow[] };
  };
}

export type FrontierAxis = "cost" | "time";
export type Track = "fixed" | "free";
export type DotShape = "circle" | "triangle" | "square" | "diamond";

/** Score used to order rows that have no rank yet (higher first). */
export function rankSortValue(row: LeaderboardRow): number {
  if (row.rank !== null) return row.rank;
  return 1000 + (1 - (row.score ?? 0));
}

/**
 * Marker shape for a config's reasoning effort. Seed configs leave `modelTier`
 * unset on purpose (a tier moves under a run), so the effort is the setting that
 * actually differs between two dots of one model: circle = harness default (or a
 * config that ran at several efforts), triangle = low, square = medium, diamond =
 * high and above.
 */
export function effortShape(efforts: readonly string[]): DotShape {
  if (efforts.length !== 1) return "circle";
  switch (efforts[0]) {
    case "off":
    case "low":
      return "triangle";
    case "medium":
      return "square";
    case "high":
    case "xhigh":
    case "max":
      return "diamond";
    default:
      return "circle";
  }
}

export const SHAPE_LEGEND: { shape: DotShape; label: string }[] = [
  { shape: "circle", label: "default effort" },
  { shape: "triangle", label: "low" },
  { shape: "square", label: "medium" },
  { shape: "diamond", label: "high +" },
];

export interface FrontierDot {
  configId: string;
  harness: string;
  resolvedModel: string;
  x: number;
  y: number;
  /** Whisker ends; null when the interval is missing or collapsed to a point. */
  ciLo: number | null;
  ciHi: number | null;
  shape: DotShape;
  efforts: string[];
  /** Drawn hollow: partial coverage, too few attempts, or a missing axis reading. */
  hollow: boolean;
  /** Why it is hollow, for the hover card. */
  hollowReasons: string[];
  onFrontier: boolean;
  /** Outside the table track being shown; drawn faded. */
  dim: boolean;
  point: FrontierPoint;
}

export interface FrontierDots {
  dots: FrontierDot[];
  /** Configs with no reading on this axis (no price or no timing yet). */
  unplotted: string[];
}

/** Below this width a CI is drawn as a point, not a whisker. */
const CI_EPS = 1e-6;

/**
 * Turn a frontier response into chart dots for one axis. `efforts` comes from
 * the leaderboard rows (the frontier payload does not carry it); `visible` is
 * the set of config ids in the table track on screen (null = all visible).
 */
export function buildFrontierDots(
  frontier: FrontierResponse,
  axis: FrontierAxis,
  efforts: ReadonlyMap<string, string[]>,
  visible: ReadonlySet<string> | null,
): FrontierDots {
  const onFrontier = new Set(axis === "cost" ? frontier.frontier.cost : frontier.frontier.time);
  const dots: FrontierDot[] = [];
  const unplotted: string[] = [];
  for (const p of frontier.points) {
    const x = axis === "cost" ? p.avgCostUsd : p.medianAgentMs;
    if (x === null || !(x > 0)) {
      unplotted.push(p.configId);
      continue;
    }
    const complete = axis === "cost" ? p.costComplete : p.timeComplete;
    const reasons: string[] = [];
    if (!p.fullCoverage) {
      reasons.push(`ran ${p.scenarios.covered} of ${p.scenarios.expected} scenarios`);
    }
    if (p.lowN) reasons.push(`under ${frontier.lowNThreshold} attempts on some scenario`);
    if (!complete) {
      reasons.push(
        axis === "cost" ? "some scenarios have no price" : "some scenarios have no timing",
      );
    }
    const width = p.scoreCi.hi - p.scoreCi.lo;
    const eff = efforts.get(p.configId) ?? [];
    dots.push({
      configId: p.configId,
      harness: p.harness,
      resolvedModel: p.resolvedModel,
      x,
      y: p.score,
      ciLo: width > CI_EPS ? p.scoreCi.lo : null,
      ciHi: width > CI_EPS ? p.scoreCi.hi : null,
      shape: effortShape(eff),
      efforts: eff,
      hollow: reasons.length > 0,
      hollowReasons: reasons,
      onFrontier: onFrontier.has(p.configId),
      dim: visible !== null && !visible.has(p.configId),
      point: p,
    });
  }
  return { dots, unplotted };
}

/** The frontier dots left to right (the API orders ids by ascending x). */
export function frontierLine(dots: readonly FrontierDot[], ids: readonly string[]): FrontierDot[] {
  const byId = new Map(dots.map((d) => [d.configId, d]));
  const line: FrontierDot[] = [];
  for (const id of ids) {
    const d = byId.get(id);
    if (d) line.push(d);
  }
  return line.sort((a, b) => a.x - b.x);
}

/** Config ids shown in the table for the selected track (chart dots outside it fade). */
export function trackConfigIds(
  lb: LeaderboardResponse,
  track: Track,
  harness: string | null,
): Set<string> {
  const rows =
    track === "free"
      ? lb.tracks.bestHarnessPerModel.rows
      : (lb.tracks.fixedHarness.find((g) => g.harness === harness)?.rows ?? []);
  return new Set(rows.map((r) => r.configId));
}

/** Reasoning efforts by config, from the leaderboard's per-config rows (both tracks). */
export function effortsByConfig(lb: LeaderboardResponse): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of lb.tracks.fixedHarness) {
    for (const r of g.rows) out.set(r.configId, r.efforts);
  }
  for (const r of lb.tracks.bestHarnessPerModel.rows) {
    if (!out.has(r.configId)) out.set(r.configId, r.efforts);
  }
  return out;
}

/**
 * The harness whose table opens first on the fixed-harness track: the one with
 * the best-scoring row, so the default view shows the strongest group. Null when
 * there are no groups.
 */
export function defaultHarness(lb: LeaderboardResponse): string | null {
  let best: { harness: string; score: number } | null = null;
  for (const g of lb.tracks.fixedHarness) {
    for (const r of g.rows) {
      const s = r.score ?? -1;
      if (best === null || s > best.score) best = { harness: g.harness, score: s };
    }
  }
  return best?.harness ?? lb.tracks.fixedHarness[0]?.harness ?? null;
}

export interface FrontierPick {
  label: string;
  configId: string;
  point: FrontierPoint;
}

/**
 * The three answers the page leads with. Empty when no frontier is drawn: the
 * page then explains why instead of naming a "best" setup from partial data.
 */
export function frontierPicks(frontier: FrontierResponse): FrontierPick[] {
  const byId = new Map(frontier.points.map((p) => [p.configId, p]));
  const pick = (label: string, id: string | undefined): FrontierPick | null => {
    const point = id === undefined ? undefined : byId.get(id);
    return point === undefined ? null : { label, configId: point.configId, point };
  };
  const cost = frontier.frontier.cost;
  const time = frontier.frontier.time;
  const onFrontier = [...new Set([...cost, ...time])]
    .map((id) => byId.get(id))
    .filter((p): p is FrontierPoint => p !== undefined);
  const top = onFrontier.reduce<FrontierPoint | null>(
    (best, p) => (best === null || p.score > best.score ? p : best),
    null,
  );
  return [
    pick("Highest score", top?.configId),
    pick("Cheapest on the frontier", cost[0]),
    pick("Fastest on the frontier", time[0]),
  ].filter((p): p is FrontierPick => p !== null);
}

/** Log-scale ticks (1, 2, 5 per decade) inside [lo, hi]. */
export function logTicks(lo: number, hi: number): number[] {
  if (!(lo > 0) || !(hi >= lo)) return [];
  const out: number[] = [];
  const firstDecade = Math.floor(Math.log10(lo));
  const lastDecade = Math.ceil(Math.log10(hi));
  for (let d = firstDecade; d <= lastDecade; d++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** d;
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(Number(v.toPrecision(12)));
    }
  }
  return out;
}

const TIME_TICKS_MS = [1, 2, 5, 10, 15, 30, 45, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200].map(
  (s) => s * 1000,
);

/** Ticks for an agent-time axis at round durations (10s, 30s, 1m, 2m, 5m...) inside [lo, hi] ms. */
export function timeTicks(lo: number, hi: number): number[] {
  const inside = TIME_TICKS_MS.filter((t) => t >= lo * (1 - 1e-9) && t <= hi * (1 + 1e-9));
  return inside.length >= 2 ? inside : logTicks(lo, hi);
}

/**
 * Round the y-range of the chart outward to 0.05 steps, clamped to [0, 1], so a
 * cluster near 0.9 is not squashed into the top of a 0-1 axis.
 */
export function scoreDomain(dots: readonly FrontierDot[]): { lo: number; hi: number } {
  if (dots.length === 0) return { lo: 0, hi: 1 };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const d of dots) {
    lo = Math.min(lo, d.ciLo ?? d.y);
    hi = Math.max(hi, d.ciHi ?? d.y);
  }
  const pad = Math.max(0.02, (hi - lo) * 0.1);
  const step = 0.05;
  const domLo = Number(Math.max(0, Math.floor((lo - pad) / step) * step).toFixed(2));
  const domHi = Number(Math.min(1, Math.ceil((hi + pad) / step) * step).toFixed(2));
  if (domHi - domLo >= 0.1) return { lo: domLo, hi: domHi };
  return { lo: Number(Math.max(0, domHi - 0.1).toFixed(2)), hi: domHi };
}

// ---- heatmap, reliability and cell (Phase 6) ----

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
  passRate: number | null;
  configs: number;
  configsPassing: number;
}

export interface HeatmapResponse {
  suiteVersion: string;
  generatedAt: string;
  lowNThreshold: number;
  scenarioIds: string[];
  configIds: string[];
  cells: HeatmapCell[];
  anyConfig: HeatmapAnyRow[];
}

export interface ReliabilityPoint {
  k: number;
  passPowK: number | null;
  passAtK: number | null;
  scenarios: number;
}

export interface TrendPoint {
  runId: string;
  runName: string | null;
  createdAt: string;
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
  trend: TrendPoint[];
}

export interface ReliabilityResponse {
  suiteVersion: string;
  generatedAt: string;
  maxK: number;
  configs: ReliabilityConfig[];
}

export interface CellAttempt {
  id: string;
  runId: string;
  runName: string | null;
  runCreatedAt: string;
  attemptIndex: number;
  status: string;
  exclusion: string | null;
  score: number | null;
  costUsd: number | null;
  durationMs: number | null;
  agentMs: number | null;
  startedAt: string | null;
  error: string | null;
  resolvedModel: string | null;
  reasoningEffort: string | null;
}

export interface CellResponse {
  suiteVersion: string;
  scenarioId: string;
  configId: string;
  graded: number;
  passed: number;
  failed: number;
  errors: number;
  attempts: CellAttempt[];
  truncated: boolean;
}

/** Configs a scenario needs before an all-red or all-green column means anything. */
export const FLAG_MIN_CONFIGS = 3;

export type ScenarioHealth = "broken-or-hard" | "saturated" | "mixed" | "thin";

/**
 * What a scenario's "any config" reading says about the scenario itself. Nothing
 * passes it (`broken-or-hard`) or everything does (`saturated`): both mean the
 * scenario stops separating setups. With fewer than {@link FLAG_MIN_CONFIGS}
 * configs the reading is `thin`: too little to call.
 */
export function scenarioHealth(row: HeatmapAnyRow | undefined): ScenarioHealth {
  if (row === undefined || row.configs < FLAG_MIN_CONFIGS || row.graded === 0) return "thin";
  if (row.configsPassing === 0) return "broken-or-hard";
  if (row.passed === row.graded) return "saturated";
  return "mixed";
}

export const HEALTH_TEXT: Record<Exclude<ScenarioHealth, "mixed" | "thin">, string> = {
  "broken-or-hard": "No config passes it: broken or too hard",
  saturated: "Every graded attempt passes: it no longer separates setups",
};

/** The heatmap's cells keyed by `scenarioId` then `configId`, for O(1) lookup while drawing. */
export function heatmapIndex(h: HeatmapResponse): Map<string, HeatmapCell> {
  return new Map(h.cells.map((c) => [cellKey(c.scenarioId, c.configId), c]));
}

export function cellKey(scenarioId: string, configId: string): string {
  return `${scenarioId}\u0000${configId}`;
}

/**
 * Cell background: red at a 0% pass rate through amber to green at 100%. Mixing
 * in `--panel` keeps text readable in both themes. Null (errors only) is neutral.
 */
export function passRateColor(rate: number | null): string {
  if (rate === null) return "var(--panel-2)";
  const t = Math.max(0, Math.min(1, rate));
  const hue = t < 0.5 ? "var(--red)" : "var(--green)";
  const strength = Math.round(Math.abs(t - 0.5) * 2 * 62 + 14);
  return `color-mix(in oklab, ${hue} ${strength}%, var(--panel))`;
}

export interface ReliabilityRow {
  configId: string;
  harness: string;
  resolvedModel: string;
  attempts: number;
  fullCoverage: boolean;
  lowN: boolean;
  /** Chance one attempt passes. */
  passAt1: number;
  /** Chance k attempts in a row all pass. */
  passPowK: number;
  /** Scenarios that have at least k graded attempts. */
  scenarios: number;
  /** passAt1 - passPowK: what repeating the task costs. 0 = fully reliable. */
  gap: number;
}

/**
 * Rows for the pass@1 vs pass^k chart at one `k`, most reliable first. A config
 * with no scenario at k graded attempts has no pass^k yet and is left out (the
 * page lists it as waiting for more repeats).
 */
export function reliabilityRows(
  rel: ReliabilityResponse,
  k: number,
): { rows: ReliabilityRow[]; waiting: ReliabilityConfig[] } {
  const rows: ReliabilityRow[] = [];
  const waiting: ReliabilityConfig[] = [];
  for (const c of rel.configs) {
    const point = c.curve.find((p) => p.k === k);
    if (c.passAt1 === null || point === undefined || point.passPowK === null) {
      waiting.push(c);
      continue;
    }
    rows.push({
      configId: c.configId,
      harness: c.harness,
      resolvedModel: c.resolvedModel,
      attempts: c.attempts,
      fullCoverage: c.fullCoverage,
      lowN: c.lowN,
      passAt1: c.passAt1,
      passPowK: point.passPowK,
      scenarios: point.scenarios,
      gap: Math.max(0, c.passAt1 - point.passPowK),
    });
  }
  rows.sort((a, b) => b.passPowK - a.passPowK || b.passAt1 - a.passAt1);
  return { rows, waiting };
}

export interface TrendLine {
  configId: string;
  points: { x: number; y: number; lo: number | null; hi: number | null; point: TrendPoint }[];
}

export type TrendMetric = "score" | "passRate";

/**
 * A config's runs as chart points, oldest first. The score has a bootstrap band;
 * the pass rate does not, so its band ends are null. Runs with no value on the
 * metric are skipped rather than drawn as zero.
 */
export function trendLine(c: ReliabilityConfig, metric: TrendMetric): TrendLine {
  const points: TrendLine["points"] = [];
  for (const p of c.trend) {
    const x = Date.parse(p.createdAt);
    const y = metric === "score" ? p.score : p.passRate;
    if (!Number.isFinite(x) || y === null) continue;
    const width = p.scoreCi === null ? 0 : p.scoreCi.hi - p.scoreCi.lo;
    const band = metric === "score" && p.scoreCi !== null && width > 1e-6;
    points.push({
      x,
      y,
      lo: band ? (p.scoreCi as CiBounds).lo : null,
      hi: band ? (p.scoreCi as CiBounds).hi : null,
      point: p,
    });
  }
  return { configId: c.configId, points };
}

/** Configs worth drawing by default: the best few by score, at least two runs each. */
export function defaultTrendConfigs(rel: ReliabilityResponse, limit = 3): string[] {
  const withHistory = rel.configs.filter((c) => c.trend.filter((p) => p.score !== null).length >= 2);
  const pool = withHistory.length > 0 ? withHistory : rel.configs;
  return pool
    .slice()
    .sort(
      (a, b) =>
        Number(b.fullCoverage) - Number(a.fullCoverage) ||
        (b.trend.at(-1)?.score ?? 0) - (a.trend.at(-1)?.score ?? 0),
    )
    .slice(0, limit)
    .map((c) => c.configId);
}
