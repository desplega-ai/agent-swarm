/**
 * Read path of the savings rollup: sums the daily buckets of a window, shares
 * the schedule cap across the versions of a job, applies the enabled-only rule
 * and prices at the requested tier. All of that happens at read time, so a
 * tier or window change needs no recomputation.
 */
import { getDbClient } from "../db";
import type { DbParam } from "../db-client";
import {
  computeScriptWindow,
  computeWorkflowWindow,
  countScriptRuns,
  type DayFacts,
  LIVE_MAX_RUNS,
  type SavingsSql,
  type ScriptWindowFacts,
} from "./compute";
import {
  allocateSchedule,
  type CurveSet,
  INLINE_SCRIPT_NAME,
  isEnabledOnlyRouter,
  MODEL_VERSION,
  type PricedWorkflow,
  priceScript,
  priceWorkflow,
  type SavingsBand,
  type SavingsTier,
  type ScheduleAllocation,
  type ScriptFacts,
  type ScriptKind,
  splitByDay,
  splitScriptByDay,
  type WorkflowFacts,
} from "./model";
import { dayStartIso, SAVINGS_FACT_COLUMNS, savingsRollupGeneration, utcDay } from "./rollup";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type SavingsWindow = { start: string; end: string; days: number };

export type WorkflowSavingsRow = PricedWorkflow & { workflowId: string; name: string };

export type SavingsTotals = {
  runs: number;
  substitutedRuns: number;
  enabledOnlyRuns: number;
  measuredUsd: number;
  estimatedLlmUsd: number;
  actualUsd: number;
  agentOnlyUsd: SavingsBand;
  savingUsd: SavingsBand;
  actualHours: number;
  hoursSaved: SavingsBand;
};

export type SavingsDailyPoint = {
  day: string;
  savingUsd: number;
  actualUsd: number;
  measuredUsd: number;
  estimatedLlmUsd: number;
};

export type WorkflowSavingsRead = {
  window: SavingsWindow;
  /** Newest rollup time of the window's days; null before the first rollup. */
  computedAt: string | null;
  /** Every day of the window has been computed under the current model version. */
  complete: boolean;
  /**
   * The runs of the window's first, partial day could not be scanned live (more
   * than the live limit, or a busy database): that day's bucket was scaled to
   * the part inside the window instead.
   */
  boundaryEstimated: boolean;
  rows: WorkflowSavingsRow[];
  total: SavingsTotals | null;
  /** p50 per UTC day the window touches (`days + 1`), oldest first, summed over the rows; they add up to the total. */
  points: SavingsDailyPoint[];
};

type BucketRow = WorkflowFacts & { day: string; jobId: string; jobKey: string; jobName: string };
type Job = {
  workflowId: string;
  jobKey: string;
  name: string;
  facts: WorkflowFacts;
  days: BucketRow[];
};

const zeroFacts = (): WorkflowFacts => ({
  runs: 0,
  countedRuns: 0,
  schedRuns: 0,
  schedEffectRuns: 0,
  eventRuns: 0,
  effectRuns: 0,
  effectOpsSum: 0,
  opsSum: 0,
  agentTasks: 0,
  agentUsd: 0,
  agentMs: 0,
  followupUsd: 0,
  recordedLlmUsd: 0,
  estimatedLlmUsd: 0,
  computeSecs: 0,
});

function addFacts(into: WorkflowFacts, row: WorkflowFacts): void {
  for (const c of SAVINGS_FACT_COLUMNS) into[c] += Number(row[c]) || 0;
}

/**
 * The rolling window: `days` x 24 hours ending now, the same window the live
 * computation uses. Its start is taken to the minute, so reads within a minute
 * share one scan of the partial first day. It touches `days + 1` UTC days: the
 * first is partial and is scanned live; the others come from the buckets.
 */
export function savingsWindow(
  days: number,
  now: number,
): SavingsWindow & { firstDay: string; lastDay: string } {
  const startMs = Math.floor(now / MINUTE_MS) * MINUTE_MS - days * DAY_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(now).toISOString(),
    days,
    firstDay: utcDay(startMs),
    lastDay: utcDay(now),
  };
}

/** UTC days from `firstDay` to `lastDay`, both included. */
function daysBetween(firstDay: string, lastDay: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(dayStartIso(firstDay));
    t <= Date.parse(dayStartIso(lastDay));
    t += DAY_MS
  ) {
    out.push(utcDay(t));
  }
  return out;
}

/** Live facts of one workflow over a first-day slice by UTC minute, or the slice's run count (null when unknown) when they could not be read. */
type SliceResult = { byMinute: DayFacts[] } | { runs: number | null };
/** Live facts by script name over a first-day slice by UTC minute, or null when they could not be read. */
type ScriptSliceResult = ScriptWindowFacts[] | null;
/** First-day scans by workflow (or script read) and slice start, kept a little past the slice start's minute or hour. */
const sliceCache = new Map<string, { at: number; ttl: number; result: Promise<unknown> }>();
const SLICE_TTL_MS = 2 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const FLEET_SLICE_TTL_MS = HOUR_MS + 2 * MINUTE_MS;
/** First-day scans in flight per read: below the default db-query concurrency cap of 3. */
const FIRST_DAY_SCAN_CONCURRENCY = 2;

/** One scan per key at a time, kept for `ttl`; a failed scan reads as `failed` and is not kept. */
function cachedScan<T>(
  key: string,
  ttl: number,
  scan: () => Promise<T>,
  failed: T,
  label: string,
): Promise<T> {
  const hit = sliceCache.get(key);
  if (hit) return hit.result as Promise<T>;
  const now = Date.now();
  // A slice start of an older minute (or hour) is never read again.
  for (const [k, v] of sliceCache) if (now - v.at > v.ttl) sliceCache.delete(k);
  const result: Promise<T> = scan().catch((err): T => {
    console.warn(
      `[savings-read] first-day scan of ${label} failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    );
    // A failed scan is not kept: the next read scans again.
    if (sliceCache.get(key)?.result === result) sliceCache.delete(key);
    return failed;
  });
  sliceCache.set(key, { at: now, ttl, result });
  return result;
}

function scanSlice(
  workflow: { id: string; definition: unknown },
  slice: { start: string; end: string },
  sql: SavingsSql,
  ttl: number,
): Promise<SliceResult> {
  return cachedScan<SliceResult>(
    `${workflow.id}|${slice.start}`,
    ttl,
    async () => {
      const out = await computeWorkflowWindow(workflow, slice, sql, { bucket: "minute" });
      return out.status === "ok" ? { byMinute: out.byDay } : { runs: out.runs };
    },
    { runs: null },
    workflow.id,
  );
}

const COUNT_COLUMNS = new Set<keyof WorkflowFacts>([
  "runs",
  "countedRuns",
  "schedRuns",
  "schedEffectRuns",
  "eventRuns",
  "effectRuns",
  "agentTasks",
]);

/**
 * The part of a first-day bucket inside the window when it could not be
 * scanned: the bucket scaled by the share of its runs in the window (known when
 * the scan refused on run count), else by the share of the day in the window.
 */
function scaleBucket(bucket: WorkflowFacts, share: number): WorkflowFacts {
  const out = zeroFacts();
  for (const c of SAVINGS_FACT_COLUMNS) {
    const v = (Number(bucket[c]) || 0) * share;
    out[c] = COUNT_COLUMNS.has(c) ? Math.round(v) : v;
  }
  return out;
}

function parseDefinition(definition: unknown): unknown {
  if (typeof definition !== "string") return definition ?? {};
  try {
    return JSON.parse(definition);
  } catch {
    return {};
  }
}

const isRetired = (name: string) => /-retired-\d{4}-\d{2}-\d{2}$/.test(name);

/** At most this many UTC days of buckets per synchronous query. */
const CHUNK_DAYS = 3;
/** Jobs priced between two event-loop yields. */
const PRICE_BATCH = 100;
/** A cached fleet read is reused at most this long, even when nothing bumped. */
const FLEET_CACHE_TTL_MS = 60_000;

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Run a bucket query over the window in CHUNK_DAYS slices and fold each slice
 * with `onRows`, yielding to the event loop between them: a fleet window is
 * ~100k rows, and one synchronous read and fold of them stalls every other
 * request. `params` gets each slice's bounds; slices arrive oldest first.
 */
async function forEachDayChunk<T>(
  sql: string,
  params: (from: string, to: string) => DbParam[],
  firstDay: string,
  lastDay: string,
  onRows: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  for (let from = firstDay; from <= lastDay; ) {
    const toMs = Math.min(
      Date.parse(dayStartIso(from)) + (CHUNK_DAYS - 1) * DAY_MS,
      Date.parse(dayStartIso(lastDay)),
    );
    if (from !== firstDay) await yieldLoop();
    await onRows(await getDbClient().query<T>(sql, params(from, utcDay(toMs))));
    from = utcDay(toMs + DAY_MS);
  }
}

/** The priced part of a read, shared by every band: the band only picks the total. */
type PricedCore<R> = {
  computedAt: string | null;
  boundaryEstimated: boolean;
  rows: R[];
  jobTotal: SavingsTotals | null;
  fleetTotal: SavingsTotals | null;
  points: SavingsDailyPoint[];
};

type FleetCacheEntry = { fingerprint: string; at: number; value: Promise<PricedCore<unknown>> };
const fleetCache = new Map<string, FleetCacheEntry>();
let fleetLoads = 0;

const curveKeys = new WeakMap<CurveSet, string>();

/** Cache-key part for a session-cost curve: a deployment calibration prices differently from the shipped one. */
function curveKey(curve: CurveSet | undefined): string {
  if (!curve) return "shipped";
  let key = curveKeys.get(curve);
  if (key === undefined) {
    key = Bun.hash(JSON.stringify(curve)).toString(36);
    curveKeys.set(curve, key);
  }
  return key;
}

/** Test hook: forget cached fleet reads and first-day scans. */
export function resetSavingsReadCache(): void {
  sliceCache.clear();
  fleetCache.clear();
  fleetLoads = 0;
}

/** Test hook: how many fleet reads hit the database since the last reset. */
export const savingsFleetLoads = (): number => fleetLoads;

/**
 * One load per window, tier and rollup state: concurrent readers (the fleet
 * page fires four) share the in-flight promise, and later ones reuse the
 * result until a rollup write changes the fingerprint or the TTL runs out.
 */
function cachedFleet<R>(
  key: string,
  fingerprint: string,
  load: () => Promise<PricedCore<R>>,
): Promise<PricedCore<R>> {
  const now = Date.now();
  const hit = fleetCache.get(key);
  if (hit && hit.fingerprint === fingerprint && now - hit.at < FLEET_CACHE_TTL_MS) {
    return hit.value as Promise<PricedCore<R>>;
  }
  for (const [k, e] of fleetCache) if (now - e.at >= FLEET_CACHE_TTL_MS) fleetCache.delete(k);
  fleetLoads++;
  const value = load();
  const entry: FleetCacheEntry = { fingerprint, at: now, value };
  fleetCache.set(key, entry);
  value.catch(() => {
    if (fleetCache.get(key) === entry) fleetCache.delete(key);
  });
  return value;
}

/**
 * Price the workflows of a window from the rollup: every workflow when
 * `workflowId` is absent, else that one (its job's other versions still share
 * the schedule cap). `band: "fleet"` prices the total with the fleet spread
 * even for one row, for a caller that adds it to other totals.
 */
export async function readWorkflowSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  workflowId?: string;
  band?: "fleet";
  /** Runs the live scan of the window's partial first day. */
  sql?: SavingsSql;
  /** A deployment calibration of the session-cost curve; the shipped curve when absent. */
  curve?: CurveSet;
}): Promise<WorkflowSavingsRead> {
  const client = getDbClient();
  const { firstDay, lastDay, ...window } = savingsWindow(opts.days, opts.now);
  const calendarDays = daysBetween(firstDay, lastDay);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='workflow' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= calendarDays.length;
  const markerAt = marker?.at ?? null;
  const scope = {
    days: opts.days,
    tier: opts.tier,
    window,
    firstDay,
    lastDay,
    calendarDays,
    markerAt,
    sql: opts.sql,
    curve: opts.curve,
  };

  let core: PricedCore<WorkflowSavingsRow>;
  if (opts.workflowId) {
    const own = await client.get<{ jobKey: string }>(
      "SELECT jobKey FROM automation_savings_daily WHERE jobKind='workflow' AND jobId=? AND day>=? AND day<=? LIMIT 1",
      [opts.workflowId, firstDay, lastDay],
    );
    if (!own) {
      return {
        window,
        computedAt: markerAt,
        complete,
        boundaryEstimated: false,
        rows: [],
        total: null,
        points: [],
      };
    }
    core = await priceWorkflowBuckets({
      ...scope,
      jobKey: own.jobKey,
      workflowId: opts.workflowId,
    });
  } else {
    // The window start is part of the key: the first day's live scan depends on it.
    core = await cachedFleet(
      `workflow:${opts.days}:${opts.tier}:${curveKey(opts.curve)}:${window.start}:${lastDay}`,
      `${savingsRollupGeneration()}:${marker?.n}:${markerAt}`,
      () => priceWorkflowBuckets(scope),
    );
  }
  const band = opts.band ?? (core.rows.length === 1 ? "job" : "fleet");
  return {
    window,
    computedAt: core.computedAt,
    complete,
    boundaryEstimated: core.boundaryEstimated,
    rows: [...core.rows],
    total: band === "job" ? core.jobTotal : core.fleetTotal,
    points: [...core.points],
  };
}

async function priceWorkflowBuckets(scope: {
  days: number;
  tier: SavingsTier;
  window: SavingsWindow;
  firstDay: string;
  lastDay: string;
  calendarDays: string[];
  markerAt: string | null;
  sql?: SavingsSql;
  curve?: CurveSet;
  jobKey?: string;
  workflowId?: string;
}): Promise<PricedCore<WorkflowSavingsRow>> {
  const keyFilter = scope.jobKey !== undefined ? "AND jobKey=?" : "";
  let computedAt = scope.markerAt;
  let boundaryEstimated = false;
  const jobs = new Map<string, Job>();
  const fold = async (buckets: (BucketRow & { computedAt: string })[]) => {
    for (const b of buckets)
      if (!computedAt || b.computedAt > computedAt) computedAt = b.computedAt;
    // Slices arrive oldest first: only the first one holds the partial first day.
    if (buckets.some((b) => b.day === scope.firstDay)) {
      boundaryEstimated = await clipFirstDay(
        buckets,
        scope.window,
        scope.firstDay,
        !scope.workflowId,
        scope.sql,
      );
    }
    for (const b of buckets) {
      if (!(Number(b.runs) > 0)) continue;
      let job = jobs.get(b.jobId);
      if (!job) {
        job = {
          workflowId: b.jobId,
          jobKey: b.jobKey,
          name: b.jobName,
          facts: zeroFacts(),
          days: [],
        };
        jobs.set(b.jobId, job);
      }
      // The newest bucket carries the current name.
      job.name = b.jobName;
      addFacts(job.facts, b);
      job.days.push(b);
    }
  };
  await forEachDayChunk(
    `SELECT day, jobId, jobKey, jobName, computedAt, ${SAVINGS_FACT_COLUMNS.join(", ")}
     FROM automation_savings_daily
     WHERE jobKind='workflow' AND subKind='' AND modelVersion=? AND day>=? AND day<=? ${keyFilter}
     ORDER BY day`,
    (from, to) => [MODEL_VERSION, from, to, ...(scope.jobKey !== undefined ? [scope.jobKey] : [])],
    scope.firstDay,
    scope.lastDay,
    fold,
  );

  // Versions of one job share the schedule cap: the live version first, then
  // retired copies by name. A version priced by the enabled-only rule takes no
  // share of the cap.
  const allocations = new Map<string, ScheduleAllocation>();
  const byKey = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    if (isEnabledOnlyRouter(job.facts, scope.days)) continue;
    byKey.set(job.jobKey, [...(byKey.get(job.jobKey) ?? []), job]);
  }
  for (const versions of byKey.values()) {
    versions.sort(
      (a, b) =>
        Number(isRetired(a.name)) - Number(isRetired(b.name)) || a.name.localeCompare(b.name),
    );
    const shares = allocateSchedule(
      versions.map((v) => v.facts),
      scope.days,
    );
    versions.forEach((v, i) => {
      allocations.set(v.workflowId, shares[i] as ScheduleAllocation);
    });
  }

  const selected = [...jobs.values()].filter(
    (j) => !scope.workflowId || j.workflowId === scope.workflowId,
  );
  const rows: WorkflowSavingsRow[] = [];
  const jobParts: PricedWorkflow[] = [];
  const fleetParts: PricedWorkflow[] = [];
  const daily = dayTotals(scope.calendarDays);
  const pricing = { tier: scope.tier, days: scope.days, curve: scope.curve };
  for (const [i, job] of selected.entries()) {
    if (i > 0 && i % PRICE_BATCH === 0) await yieldLoop();
    const allocation = allocations.get(job.workflowId);
    const priced = priceWorkflow(job.facts, { ...pricing, band: "job" }, allocation);
    rows.push({ ...priced, workflowId: job.workflowId, name: job.name });
    jobParts.push(priced);
    fleetParts.push(priceWorkflow(job.facts, { ...pricing, band: "fleet" }, allocation));
    daily.add(splitByDay(job.facts, job.days, pricing, priced));
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  return {
    computedAt,
    boundaryEstimated,
    rows,
    jobTotal: jobParts.length > 0 ? sumTotals(jobParts) : null,
    fleetTotal: fleetParts.length > 0 ? sumTotals(fleetParts) : null,
    points: rows.length > 0 ? daily.points : [],
  };
}

/**
 * Replace each first-day bucket with the facts of the runs inside the window,
 * scanned live (the window starts mid-day). Returns whether any of them had to
 * be estimated instead.
 *
 * A fleet read (no workflowId) scans from the window start floored to the hour
 * and keeps the scans for that hour, so list reads cost one scan per workflow
 * per hour, not per minute. The scan groups runs by minute, and every read
 * keeps only the minutes from `window.start` on, so both reads stay exact to
 * the minute. An estimate is scaled to the part of the slice inside the window.
 */
async function clipFirstDay(
  buckets: BucketRow[],
  window: SavingsWindow,
  firstDay: string,
  fleet: boolean,
  sql: SavingsSql = (q, p) => getDbClient().query(q, p),
): Promise<boolean> {
  const startMs = Date.parse(window.start);
  // A window starting at midnight keeps the whole first-day bucket.
  if (window.start === dayStartIso(firstDay)) return false;
  const sliceStart = fleet
    ? new Date(Math.floor(startMs / HOUR_MS) * HOUR_MS).toISOString()
    : window.start;
  const first = buckets.filter((b) => b.day === firstDay);
  if (first.length === 0) return false;
  const ids = [...new Set(first.map((b) => b.jobId))];
  const defs = await getDbClient().query<{ id: string; definition: unknown }>(
    `SELECT id, definition FROM workflows WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const defOf = new Map(defs.map((d) => [d.id, parseDefinition(d.definition)]));
  const slice = { start: sliceStart, end: dayStartIso(utcDay(startMs + DAY_MS)) };
  const ttl = fleet ? FLEET_SLICE_TTL_MS : SLICE_TTL_MS;
  const endMs = Date.parse(slice.end);
  const dayShare = (endMs - startMs) / DAY_MS;
  // The part of the slice (floored to the hour on a fleet read) inside the window.
  const sliceShare = (endMs - startMs) / (endMs - Date.parse(slice.start));
  const startMinute = minuteKey(window.start);
  let estimated = false;
  const clip = async (b: BucketRow) => {
    const result: SliceResult = defOf.has(b.jobId)
      ? await scanSlice({ id: b.jobId, definition: defOf.get(b.jobId) }, slice, sql, ttl)
      : { runs: null };
    let facts: WorkflowFacts;
    if ("byMinute" in result) {
      facts = zeroFacts();
      for (const m of result.byMinute) if (m.day >= startMinute) addFacts(facts, m);
    } else {
      estimated = true;
      const share =
        result.runs !== null && Number(b.runs) > 0
          ? Math.min(1, result.runs / Number(b.runs)) * sliceShare
          : dayShare;
      facts = scaleBucket(b, share);
    }
    for (const c of SAVINGS_FACT_COLUMNS) b[c] = facts[c];
  };
  // A few scans at a time, below the bounded executor's concurrency cap.
  const queue = [...first];
  await Promise.all(
    Array.from({ length: Math.min(FIRST_DAY_SCAN_CONCURRENCY, queue.length) }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await clip(b);
    }),
  );
  return estimated;
}

function sumBand(parts: SavingsBand[]): SavingsBand {
  return {
    p10: parts.reduce((s, b) => s + b.p10, 0),
    p50: parts.reduce((s, b) => s + b.p50, 0),
    p90: parts.reduce((s, b) => s + b.p90, 0),
  };
}

function sumTotals(parts: PricedWorkflow[]): SavingsTotals {
  return {
    runs: parts.reduce((s, p) => s + p.runs, 0),
    substitutedRuns: parts.reduce((s, p) => s + p.substitutedRuns, 0),
    enabledOnlyRuns: parts.reduce((s, p) => s + p.enabledOnlyRuns, 0),
    measuredUsd: parts.reduce((s, p) => s + p.measuredUsd, 0),
    estimatedLlmUsd: parts.reduce((s, p) => s + p.estimatedLlmUsd, 0),
    actualUsd: parts.reduce((s, p) => s + p.actualUsd, 0),
    agentOnlyUsd: sumBand(parts.map((p) => p.agentOnlyUsd)),
    savingUsd: sumBand(parts.map((p) => p.savingUsd)),
    actualHours: parts.reduce((s, p) => s + p.actualHours, 0),
    hoursSaved: sumBand(parts.map((p) => p.hoursSaved)),
  };
}

/**
 * One point per UTC day the window touches; `add` adds up the points of each
 * day, and days without runs stay zero. A fleet read adds each job's points
 * as it prices the job, between its event-loop yields: one pass over the
 * whole fleet's points (91k at fleet scale) stalled the loop for ~20ms.
 */
function dayTotals(calendarDays: string[]) {
  const days = calendarDays.map((day) => ({
    day,
    savingUsd: 0,
    actualUsd: 0,
    measuredUsd: 0,
    estimatedLlmUsd: 0,
  }));
  const byDay = new Map(days.map((p) => [p.day, p]));
  return {
    points: days as SavingsDailyPoint[],
    add(points: SavingsDailyPoint[]): void {
      for (const p of points) {
        const d = byDay.get(p.day);
        if (!d) continue;
        d.savingUsd += p.savingUsd;
        d.actualUsd += p.actualUsd;
        d.measuredUsd += p.measuredUsd;
        d.estimatedLlmUsd += p.estimatedLlmUsd;
      }
    },
  };
}

/** The day totals of `points`, one point per UTC day the window touches. */
function fillDays(points: SavingsDailyPoint[], calendarDays: string[]): SavingsDailyPoint[] {
  const totals = dayTotals(calendarDays);
  totals.add(points);
  return totals.points;
}

export type ScriptSavingsRow = PricedWorkflow & {
  kind: ScriptKind;
  scriptName: string;
  name: string;
};

export type ScriptSavingsRead = Omit<WorkflowSavingsRead, "rows"> & { rows: ScriptSavingsRow[] };

/** A script name the savings route answers for: one in the catalog, or the inline-source bucket. */
export async function isKnownScriptName(name: string): Promise<boolean> {
  if (name === INLINE_SCRIPT_NAME) return true;
  return !!(await getDbClient().get<{ n: number }>("SELECT 1 n FROM scripts WHERE name=? LIMIT 1", [
    name,
  ]));
}

const zeroScriptFacts = (): ScriptFacts => ({
  runs: 0,
  apiRuns: 0,
  effectRuns: 0,
  apiEffectRuns: 0,
  opsSum: 0,
  computeSecs: 0,
});

type ScriptBucketRow = {
  day: string;
  jobId: string;
  subKind: string;
  computedAt: string;
  runs: number;
  effectRuns: number;
  opsSum: number;
  computeSecs: number;
};

/** Fold a bucket row (subKind '' = non-API runs, 'api' = API runs) into script facts. */
function addScriptBucket(into: ScriptFacts, b: ScriptBucketRow): void {
  const runs = Number(b.runs) || 0;
  const effect = Number(b.effectRuns) || 0;
  into.runs += runs;
  into.opsSum += Number(b.opsSum) || 0;
  into.computeSecs += Number(b.computeSecs) || 0;
  if (b.subKind === "api") {
    into.apiRuns += runs;
    into.apiEffectRuns += effect;
  } else {
    into.effectRuns += effect;
  }
}

/**
 * Price the scripts of a window from the rollup: every script name when
 * `scriptName` is absent, else that one. A script is "scheduled" when a
 * schedule targets it now (v7 reads the same at run time); scripts are keyed
 * by name, so an agent-scoped and a global script of one name share a row.
 */
export async function readScriptSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  scriptName?: string;
  /** As in `readWorkflowSavings`. */
  band?: "fleet";
  /** Runs the live scan of the window's partial first day. */
  sql?: SavingsSql;
  /** A deployment calibration of the session-cost curve; the shipped curve when absent. */
  curve?: CurveSet;
}): Promise<ScriptSavingsRead> {
  const client = getDbClient();
  const { firstDay, lastDay, ...window } = savingsWindow(opts.days, opts.now);
  const calendarDays = daysBetween(firstDay, lastDay);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= calendarDays.length;
  const scheduled = (
    await client.query<{ scriptName: string }>(
      "SELECT DISTINCT scriptName FROM scheduled_tasks WHERE targetType='script' AND scriptName IS NOT NULL ORDER BY scriptName",
    )
  ).map((r) => r.scriptName);
  const scope = {
    days: opts.days,
    tier: opts.tier,
    window,
    firstDay,
    lastDay,
    calendarDays,
    markerAt: marker?.at ?? null,
    scheduled: new Set(scheduled),
    scriptName: opts.scriptName,
    sql: opts.sql,
    curve: opts.curve,
  };
  const core =
    opts.scriptName !== undefined
      ? await priceScriptBuckets(scope)
      : await cachedFleet(
          `script:${opts.days}:${opts.tier}:${curveKey(opts.curve)}:${window.start}:${lastDay}`,
          `${savingsRollupGeneration()}:${marker?.n}:${scope.markerAt}:${JSON.stringify(scheduled)}`,
          () => priceScriptBuckets(scope),
        );
  const band = opts.band ?? (core.rows.length === 1 ? "job" : "fleet");
  return {
    window,
    computedAt: core.computedAt,
    complete,
    boundaryEstimated: core.boundaryEstimated,
    rows: [...core.rows],
    total: band === "job" ? core.jobTotal : core.fleetTotal,
    points: [...core.points],
  };
}

async function priceScriptBuckets(scope: {
  days: number;
  tier: SavingsTier;
  window: SavingsWindow;
  firstDay: string;
  lastDay: string;
  calendarDays: string[];
  markerAt: string | null;
  scheduled: Set<string>;
  scriptName?: string;
  sql?: SavingsSql;
  curve?: CurveSet;
}): Promise<PricedCore<ScriptSavingsRow>> {
  const byName = scope.scriptName !== undefined;
  let computedAt = scope.markerAt;
  const jobs = new Map<string, { facts: ScriptFacts; days: Map<string, ScriptFacts> }>();
  await forEachDayChunk<ScriptBucketRow>(
    `SELECT day, jobId, subKind, computedAt, runs, effectRuns, opsSum, computeSecs
     FROM automation_savings_daily
     WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=? ${byName ? "AND jobId=?" : ""}
     ORDER BY day`,
    (from, to) => [MODEL_VERSION, from, to, ...(byName ? [scope.scriptName as string] : [])],
    scope.firstDay,
    scope.lastDay,
    (buckets) => {
      for (const b of buckets) {
        if (!computedAt || b.computedAt > computedAt) computedAt = b.computedAt;
        let job = jobs.get(b.jobId);
        if (!job) {
          job = { facts: zeroScriptFacts(), days: new Map() };
          jobs.set(b.jobId, job);
        }
        addScriptBucket(job.facts, b);
        const day = job.days.get(b.day) ?? zeroScriptFacts();
        addScriptBucket(day, b);
        job.days.set(b.day, day);
      }
    },
  );
  const boundaryEstimated = await clipScriptFirstDay(jobs, scope.window, scope.firstDay, scope);

  const rows: ScriptSavingsRow[] = [];
  const jobParts: PricedWorkflow[] = [];
  const fleetParts: PricedWorkflow[] = [];
  const daily = dayTotals(scope.calendarDays);
  let i = 0;
  for (const [scriptName, job] of jobs) {
    if (i > 0 && i % PRICE_BATCH === 0) await yieldLoop();
    i++;
    const kind: ScriptKind = scope.scheduled.has(scriptName)
      ? "script-scheduled"
      : "script-agent-invoked";
    const pricing = { tier: scope.tier, days: scope.days, kind, curve: scope.curve };
    const priced = priceScript(job.facts, { ...pricing, band: "job" });
    rows.push({ ...priced, kind, scriptName, name: scriptName });
    jobParts.push(priced);
    fleetParts.push(priceScript(job.facts, { ...pricing, band: "fleet" }));
    daily.add(
      splitScriptByDay(
        job.facts,
        [...job.days].map(([day, f]) => ({ ...f, day })),
        priced,
      ),
    );
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  return {
    computedAt,
    boundaryEstimated,
    rows,
    jobTotal: jobParts.length > 0 ? sumTotals(jobParts) : null,
    fleetTotal: fleetParts.length > 0 ? sumTotals(fleetParts) : null,
    points: rows.length > 0 ? daily.points : [],
  };
}

export type FleetKindTotals = {
  jobs: number;
  runs: number;
  substitutedRuns: number;
  /** p50 */
  savingUsd: number;
  /** p50 */
  hoursSaved: number;
};

export type FleetSavingsRead = Omit<WorkflowSavingsRead, "rows"> & {
  workflows: WorkflowSavingsRow[];
  scripts: ScriptSavingsRow[];
  byKind: {
    workflows: FleetKindTotals;
    scheduledScripts: FleetKindTotals;
    agentInvokedScripts: FleetKindTotals;
  };
};

function kindTotals(rows: PricedWorkflow[]): FleetKindTotals {
  return {
    jobs: rows.length,
    runs: rows.reduce((s, r) => s + r.runs, 0),
    substitutedRuns: rows.reduce((s, r) => s + r.substitutedRuns, 0),
    savingUsd: rows.reduce((s, r) => s + r.savingUsd.p50, 0),
    hoursSaved: rows.reduce((s, r) => s + r.hoursSaved.p50, 0),
  };
}

function addTotals(a: SavingsTotals, b: SavingsTotals): SavingsTotals {
  const band = (x: SavingsBand, y: SavingsBand) => sumBand([x, y]);
  return {
    runs: a.runs + b.runs,
    substitutedRuns: a.substitutedRuns + b.substitutedRuns,
    enabledOnlyRuns: a.enabledOnlyRuns + b.enabledOnlyRuns,
    measuredUsd: a.measuredUsd + b.measuredUsd,
    estimatedLlmUsd: a.estimatedLlmUsd + b.estimatedLlmUsd,
    actualUsd: a.actualUsd + b.actualUsd,
    agentOnlyUsd: band(a.agentOnlyUsd, b.agentOnlyUsd),
    savingUsd: band(a.savingUsd, b.savingUsd),
    actualHours: a.actualHours + b.actualHours,
    hoursSaved: band(a.hoursSaved, b.hoursSaved),
  };
}

/**
 * The fleet: every workflow and every script of the window. The total uses
 * the fleet band unless the fleet is one job; the daily points add up to its p50.
 */
export async function readFleetSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  /** Runs the live scan of the window's partial first day. */
  sql?: SavingsSql;
  /** A deployment calibration of the session-cost curve; the shipped curve when absent. */
  curve?: CurveSet;
}): Promise<FleetSavingsRead> {
  const wf = await readWorkflowSavings({ ...opts, band: "fleet" });
  const sc = await readScriptSavings({ ...opts, band: "fleet" });
  const { firstDay, lastDay } = savingsWindow(opts.days, opts.now);
  const all: PricedWorkflow[] = [...wf.rows, ...sc.rows];
  const total =
    all.length === 1
      ? sumTotals(all)
      : wf.total && sc.total
        ? addTotals(wf.total, sc.total)
        : (wf.total ?? sc.total);
  const points =
    all.length > 0 ? fillDays([...wf.points, ...sc.points], daysBetween(firstDay, lastDay)) : [];
  const computedAt =
    wf.computedAt && sc.computedAt
      ? wf.computedAt > sc.computedAt
        ? wf.computedAt
        : sc.computedAt
      : (wf.computedAt ?? sc.computedAt);
  return {
    window: wf.window,
    computedAt,
    complete: wf.complete && sc.complete,
    boundaryEstimated: wf.boundaryEstimated || sc.boundaryEstimated,
    workflows: wf.rows,
    scripts: sc.rows,
    total,
    points,
    byKind: {
      workflows: kindTotals(wf.rows),
      scheduledScripts: kindTotals(sc.rows.filter((r) => r.kind === "script-scheduled")),
      agentInvokedScripts: kindTotals(sc.rows.filter((r) => r.kind === "script-agent-invoked")),
    },
  };
}

/** Session spend of the whole swarm in the window, the same sum the usage page shows. */
export async function readFleetLlmUsd(window: SavingsWindow): Promise<number> {
  const row = await getDbClient().get<{ usd: number | null }>(
    "SELECT sum(totalCostUsd) usd FROM session_costs WHERE createdAt>=? AND createdAt<=?",
    [window.start, window.end],
  );
  return Number(row?.usd) || 0;
}

export type ScheduleRef = { scheduleId: string; scheduleName: string; scheduleEnabled: boolean };

/**
 * A schedule's saving. `modelled`: the schedule's workflow or script target, whose
 * row is the target's whole row because runs carry no schedule link (two schedules
 * of one target show the same row). `measured`: an agent-task schedule, which has
 * no automation to substitute, so it shows what its tasks cost and no saving.
 */
export type ScheduleSavingsRow =
  | ((WorkflowSavingsRow | ScriptSavingsRow) & ScheduleRef & { basis: "modelled" })
  | (ScheduleRef & {
      basis: "measured";
      kind: "agent-task-schedule";
      name: string;
      /** Agent tasks the schedule created in the window. */
      runs: number;
      /** Recorded cost of those tasks only; their review tasks and follow-ups are not linked to the schedule. */
      actualUsd: number;
      actualHours: number;
    });

export type ScheduleSavingsRead = {
  window: SavingsWindow;
  computedAt: string | null;
  complete: boolean;
  boundaryEstimated: boolean;
  rows: ScheduleSavingsRow[];
  /** Set for one schedule whose workflow or script no longer exists. */
  targetMissing: boolean;
};

type ScheduleTarget = {
  id: string;
  name: string;
  enabled: number;
  targetType: "agent-task" | "workflow" | "script";
  workflowId: string | null;
  scriptName: string | null;
};

/**
 * Price the schedules of a window: every schedule when `scheduleId` is absent,
 * else that one, or null when it does not exist. A disabled schedule is still
 * priced, from the runs of its target in the window, and flagged. Schedules whose
 * target has no runs in the window, or no longer exists, have no row in a list.
 */
export async function readScheduleSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  scheduleId?: string;
  sql?: SavingsSql;
  curve?: CurveSet;
}): Promise<ScheduleSavingsRead | null> {
  const client = getDbClient();
  const schedules = await client.query<ScheduleTarget>(
    `SELECT id, name, enabled, targetType, workflowId, scriptName FROM scheduled_tasks ${opts.scheduleId ? "WHERE id=?" : ""}`,
    opts.scheduleId ? [opts.scheduleId] : [],
  );
  if (opts.scheduleId && schedules.length === 0) return null;
  const single = opts.scheduleId !== undefined;
  const of = (targetType: ScheduleTarget["targetType"]) =>
    schedules.filter((s) => s.targetType === targetType);
  const base = {
    days: opts.days,
    tier: opts.tier,
    now: opts.now,
    sql: opts.sql,
    curve: opts.curve,
  };

  // One rollup read per target type, narrowed to the target when asking for one schedule.
  const workflowSchedules = of("workflow");
  const scriptSchedules = of("script");
  const workflows = workflowSchedules.some((s) => s.workflowId)
    ? await readWorkflowSavings({
        ...base,
        workflowId: single ? (workflowSchedules[0]?.workflowId ?? undefined) : undefined,
      })
    : null;
  const scripts = scriptSchedules.some((s) => s.scriptName)
    ? await readScriptSavings({
        ...base,
        scriptName: single ? (scriptSchedules[0]?.scriptName ?? undefined) : undefined,
      })
    : null;
  const workflowRows = new Map(workflows?.rows.map((r) => [r.workflowId, r]));
  const scriptRows = new Map(scripts?.rows.map((r) => [r.scriptName, r]));

  const window = savingsWindow(opts.days, opts.now);
  const measured = of("agent-task").length > 0 ? await readMeasuredSpend(window.start, opts) : null;

  const rows: ScheduleSavingsRow[] = [];
  let targetMissing = false;
  for (const s of schedules) {
    const ref: ScheduleRef = {
      scheduleId: s.id,
      scheduleName: s.name,
      scheduleEnabled: Boolean(s.enabled),
    };
    if (s.targetType === "agent-task") {
      const spend = measured?.get(s.id);
      if (spend) {
        rows.push({
          ...ref,
          basis: "measured",
          kind: "agent-task-schedule",
          name: s.name,
          runs: spend.runs,
          actualUsd: spend.usd,
          actualHours: spend.ms / 3_600_000,
        });
      }
      continue;
    }
    const target =
      s.targetType === "workflow"
        ? s.workflowId
          ? workflowRows.get(s.workflowId)
          : undefined
        : s.scriptName
          ? scriptRows.get(s.scriptName)
          : undefined;
    if (target) rows.push({ ...target, ...ref, basis: "modelled" });
    else if (single) targetMissing = !(await targetExists(s));
  }
  rows.sort(
    (a, b) =>
      Number(b.basis === "modelled") - Number(a.basis === "modelled") ||
      (a.basis === "modelled" && b.basis === "modelled"
        ? b.savingUsd.p50 - a.savingUsd.p50
        : b.basis === "measured" && a.basis === "measured"
          ? b.actualUsd - a.actualUsd
          : 0),
  );

  const reads = [workflows, scripts].filter((r) => r !== null);
  const newest = reads.map((r) => r.computedAt).filter((t): t is string => t !== null);
  return {
    window: { start: window.start, end: window.end, days: window.days },
    // Measured spend is read live, so a measured-only response is computed now.
    computedAt: newest.sort().at(-1) ?? (measured ? new Date(opts.now).toISOString() : null),
    complete: reads.every((r) => r.complete),
    boundaryEstimated: reads.some((r) => r.boundaryEstimated),
    rows,
    targetMissing,
  };
}

async function targetExists(s: ScheduleTarget): Promise<boolean> {
  // A schedule with no target configured has nothing that could be gone.
  if (s.targetType === "workflow") {
    return (
      !s.workflowId ||
      !!(await getDbClient().get("SELECT 1 FROM workflows WHERE id=?", [s.workflowId]))
    );
  }
  return !s.scriptName || (await isKnownScriptName(s.scriptName));
}

/** Tasks created by schedules in the window and their recorded cost: all schedules, or one. */
async function readMeasuredSpend(
  start: string,
  opts: { scheduleId?: string; now: number },
): Promise<Map<string, { runs: number; usd: number; ms: number }>> {
  const rows = await getDbClient().query<{
    scheduleId: string;
    runs: number;
    usd: number | null;
    ms: number | null;
  }>(
    `SELECT t.scheduleId, count(DISTINCT t.id) runs, sum(c.totalCostUsd) usd, sum(c.durationMs) ms
     FROM agent_tasks t LEFT JOIN session_costs c ON c.taskId=t.id
     WHERE ${opts.scheduleId ? "t.scheduleId=?" : "t.scheduleId IS NOT NULL"} AND t.createdAt>=? AND t.createdAt<=?
     GROUP BY t.scheduleId`,
    [...(opts.scheduleId ? [opts.scheduleId] : []), start, new Date(opts.now).toISOString()],
  );
  return new Map(
    rows.map((r) => [
      r.scheduleId,
      { runs: Number(r.runs), usd: Number(r.usd) || 0, ms: Number(r.ms) || 0 },
    ]),
  );
}

/**
 * Replace each script's first-day facts with those of its runs inside the
 * window, scanned live (the window starts mid-day), and drop scripts left with
 * no runs. When the scan fails or the slice has more than LIVE_MAX_RUNS runs,
 * the day is scaled by the share of it inside the window instead; returns
 * whether that happened. Scans are cached like the workflow slices: a fleet
 * read (no scriptName) floors the slice start to the hour and a single-script
 * read scans from the window start; both group runs by minute and keep only
 * the minutes from `window.start` on.
 */
async function clipScriptFirstDay(
  jobs: Map<string, { facts: ScriptFacts; days: Map<string, ScriptFacts> }>,
  window: SavingsWindow,
  firstDay: string,
  opts: { scriptName?: string; sql?: SavingsSql },
): Promise<boolean> {
  const fleet = opts.scriptName === undefined;
  const startMs = Date.parse(window.start);
  // A window starting at midnight keeps the whole first-day bucket.
  if (window.start === dayStartIso(firstDay)) return false;
  const sliceStart = fleet
    ? new Date(Math.floor(startMs / HOUR_MS) * HOUR_MS).toISOString()
    : window.start;
  if (![...jobs.values()].some((j) => j.days.has(firstDay))) return false;
  const slice = { start: sliceStart, end: dayStartIso(utcDay(startMs + DAY_MS)) };
  const sql: SavingsSql = opts.sql ?? ((q, p) => getDbClient().query(q, p));
  const scope = { scriptName: opts.scriptName };
  const live = await cachedScan<ScriptSliceResult>(
    `script\u0000${MODEL_VERSION}\u0000${opts.scriptName ?? "*"}\u0000${slice.start}`,
    fleet ? FLEET_SLICE_TTL_MS : SLICE_TTL_MS,
    async () => {
      // Count first, so a busy slice never reaches the effect probe.
      if ((await countScriptRuns(slice, sql, scope)) > LIVE_MAX_RUNS) return null;
      return computeScriptWindow(slice, sql, { ...scope, bucket: "minute" });
    },
    null,
    opts.scriptName ?? "scripts",
  );
  // The runs from the window start on: the cached slice may start up to 59 minutes earlier.
  const startMinute = minuteKey(window.start);
  const inWindow = new Map<string, ScriptFacts>();
  for (const s of live ?? []) {
    const facts = zeroScriptFacts();
    for (const m of s.byDay) {
      if (m.day < startMinute) continue;
      for (const k of Object.keys(facts) as (keyof ScriptFacts)[]) facts[k] += m[k];
    }
    inWindow.set(s.scriptName, facts);
  }
  const dayShare = (Date.parse(slice.end) - startMs) / DAY_MS;
  for (const [name, job] of jobs) {
    const old = job.days.get(firstDay);
    if (!old) continue;
    const clipped = live
      ? (inWindow.get(name) ?? zeroScriptFacts())
      : scaleScriptFacts(old, dayShare);
    for (const k of Object.keys(old) as (keyof ScriptFacts)[]) {
      job.facts[k] += clipped[k] - old[k];
    }
    job.days.set(firstDay, clipped);
    if (!(job.facts.runs > 0)) jobs.delete(name);
  }
  return live === null;
}

/** The UTC minute (`YYYY-MM-DDTHH:MM`) of an ISO timestamp: the key of a minute-bucketed scan. */
function minuteKey(iso: string): string {
  return iso.slice(0, 16);
}

function scaleScriptFacts(facts: ScriptFacts, share: number): ScriptFacts {
  return {
    runs: Math.round(facts.runs * share),
    apiRuns: Math.round(facts.apiRuns * share),
    effectRuns: Math.round(facts.effectRuns * share),
    apiEffectRuns: Math.round(facts.apiEffectRuns * share),
    opsSum: facts.opsSum * share,
    computeSecs: facts.computeSecs * share,
  };
}
