/**
 * Fleet benchmark: how this swarm compares with similar swarms.
 *
 * The telemetry proxy publishes fleet percentiles (`GET /v1/fleet/benchmarks`):
 * tasks per week and task success rate over installs with 10+ finished tasks
 * in 30 days, overall and by agent count, each over at least 20 installs. This
 * module places the local numbers in that distribution with the same
 * definitions. Pure: no DB, no network.
 */

export const FLEET_WINDOW_DAYS = 30;
/** Matches the proxy's population rule: fewer finished tasks are not compared. */
export const FLEET_MIN_FINISHED_TASKS = 10;
/** A new swarm's rate is measured over at least this many days. */
const MIN_OBSERVED_DAYS = 7;

export type FleetBucket = "1" | "2-5" | "6+";
export type FleetPeers = FleetBucket | "all";
export type FleetMetricKey = "tasksPerWeek" | "taskSuccessRate";
/** Where the local value sits among peers, best first. */
export type FleetBand = "top_10" | "top_25" | "above_median" | "below_median" | "bottom_25";

export interface FleetMetric {
  n: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
  omitted?: string;
}

export interface FleetBlock {
  installs: number;
  tasksPerWeek: FleetMetric;
  taskSuccessRate: FleetMetric;
}

/** `GET /v1/fleet/benchmarks` body. */
export interface FleetBenchmarks {
  window: string;
  generatedAt: string;
  minInstallsPerBucket: number;
  minFinishedTasks: number;
  overall: FleetBlock;
  byAgentCount: Partial<Record<FleetBucket, FleetBlock>>;
}

export interface LocalFleetStats {
  tasksCreated: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Where the counts start, ISO: `fleetCountStart`. */
  countStart: string;
  agents: number;
}

export interface FleetComparison {
  key: FleetMetricKey;
  value: number;
  p50: number;
  band: FleetBand;
  peers: FleetPeers;
  /** Installs behind the percentiles. */
  installs: number;
}

export function fleetBucketFor(agents: number): FleetBucket | null {
  if (agents <= 0) return null;
  if (agents === 1) return "1";
  return agents <= 5 ? "2-5" : "6+";
}

/**
 * Where the proxy starts counting this install: the window start, when this
 * install can prove the proxy saw it by then. Null otherwise, so the
 * comparison is withheld.
 *
 * `ingest` is the earliest event the ingest endpoint accepted from the API
 * server. The proxy's first event is no later, so one at or before the window
 * start means the window start. A later one proves nothing: workers send on
 * their own clocks, so the proxy may hold an earlier `occurred_at`.
 */
export function fleetCountStart(ingest: { occurredAt: string } | null, now: Date): Date | null {
  const windowStart = now.getTime() - FLEET_WINDOW_DAYS * 86_400_000;
  const accepted = ingest ? Date.parse(ingest.occurredAt) : Number.NaN;
  return Number.isFinite(accepted) && accepted <= windowStart ? new Date(windowStart) : null;
}

/** Tasks per week since `countStart`, with a 7-day floor, as the proxy computes it. */
export function localTasksPerWeek(stats: LocalFleetStats, now: Date): number {
  const start = Date.parse(stats.countStart);
  const days = Math.max(MIN_OBSERVED_DAYS, (now.getTime() - start) / 86_400_000);
  return round(stats.tasksCreated / (days / 7), 1);
}

export function localSuccessRate(stats: LocalFleetStats): number | null {
  const finished = stats.tasksCompleted + stats.tasksFailed;
  return finished > 0 ? round(stats.tasksCompleted / finished, 3) : null;
}

/** The band a value falls in; higher is better for both metrics. */
export function fleetBand(
  value: number,
  metric: Required<Pick<FleetMetric, "p25" | "p50" | "p75" | "p90">>,
): FleetBand {
  if (value >= metric.p90) return "top_10";
  if (value >= metric.p75) return "top_25";
  if (value >= metric.p50) return "above_median";
  if (value >= metric.p25) return "below_median";
  return "bottom_25";
}

function published(metric: FleetMetric | undefined) {
  if (!metric || metric.omitted) return null;
  const { p25, p50, p75, p90 } = metric;
  if (p25 === undefined || p50 === undefined || p75 === undefined || p90 === undefined) return null;
  return { p25, p50, p75, p90, n: metric.n };
}

/**
 * Compare each metric against the agent-count bucket, or against the whole
 * fleet when the bucket (or that metric in it) was withheld for having fewer
 * than 20 installs.
 */
export function compareWithFleet(
  stats: LocalFleetStats,
  fleet: FleetBenchmarks,
  now: Date,
): FleetComparison[] {
  const bucket = fleetBucketFor(stats.agents);
  const values: Record<FleetMetricKey, number | null> = {
    tasksPerWeek: localTasksPerWeek(stats, now),
    taskSuccessRate: localSuccessRate(stats),
  };
  const comparisons: FleetComparison[] = [];
  for (const key of ["tasksPerWeek", "taskSuccessRate"] as const) {
    const value = values[key];
    if (value === null) continue;
    const fromBucket = bucket ? published(fleet.byAgentCount[bucket]?.[key]) : null;
    const metric = fromBucket ?? published(fleet.overall[key]);
    if (!metric) continue;
    comparisons.push({
      key,
      value,
      p50: metric.p50,
      band: fleetBand(value, metric),
      peers: fromBucket && bucket ? bucket : "all",
      installs: metric.n,
    });
  }
  return comparisons;
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
