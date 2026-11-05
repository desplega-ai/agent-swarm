/**
 * Read path of the savings rollup: sums the daily buckets of a window, shares
 * the schedule cap across the versions of a job, applies the enabled-only rule
 * and prices at the requested tier. All of that happens at read time, so a
 * tier or window change needs no recomputation.
 */
import { getDbClient } from "../db";
import type { DbParam } from "../db-client";
import { computeWorkflowWindow, type SavingsSql } from "./compute";
import {
  allocateSchedule,
  isEnabledOnlyRouter,
  MODEL_VERSION,
  type PricedWorkflow,
  priceWorkflow,
  type SavingsBand,
  type SavingsTier,
  type ScheduleAllocation,
  splitByDay,
  type WorkflowFacts,
} from "./model";
import { dayStartIso, SAVINGS_FACT_COLUMNS, utcDay } from "./rollup";

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
  /** p50 per UTC day the window touches (`days + 1`), oldest first; they add up to the row. Only for a single workflow. */
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

/** Live facts of one workflow over the window's partial first day, or the run count (null when unknown) when they could not be read. */
type SliceResult = { facts: WorkflowFacts } | { runs: number | null };
/** First-day scans by workflow and window start, kept a little past their minute. */
const sliceCache = new Map<string, { at: number; result: Promise<SliceResult> }>();
const SLICE_TTL_MS = 2 * MINUTE_MS;

/** Test hook: forget the cached first-day scans. */
export function resetSavingsReadCache(): void {
  sliceCache.clear();
}

function scanSlice(
  workflow: { id: string; definition: unknown },
  slice: { start: string; end: string },
  sql: SavingsSql,
): Promise<SliceResult> {
  const key = `${workflow.id}|${slice.start}`;
  const hit = sliceCache.get(key);
  if (hit) return hit.result;
  const now = Date.now();
  // A window start of an older minute is never read again.
  for (const [k, v] of sliceCache) if (now - v.at > SLICE_TTL_MS) sliceCache.delete(k);
  const result = computeWorkflowWindow(workflow, slice, sql).then(
    (out): SliceResult => (out.status === "ok" ? { facts: out.facts } : { runs: out.runs }),
    (err): SliceResult => {
      console.warn(
        `[savings-read] first-day scan of ${workflow.id} failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      );
      return { runs: null };
    },
  );
  sliceCache.set(key, { at: now, result });
  return result;
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

/**
 * Price the workflows of a window from the rollup: every workflow when
 * `workflowId` is absent, else that one (its job's other versions still share
 * the schedule cap).
 */
export async function readWorkflowSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  workflowId?: string;
  /** Runs the live scan of the window's partial first day. */
  sql?: SavingsSql;
}): Promise<WorkflowSavingsRead> {
  const client = getDbClient();
  const { firstDay, lastDay, ...window } = savingsWindow(opts.days, opts.now);
  const calendarDays = daysBetween(firstDay, lastDay);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='workflow' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= calendarDays.length;

  let keyFilter = "";
  const params: DbParam[] = [MODEL_VERSION, firstDay, lastDay];
  if (opts.workflowId) {
    const own = await client.get<{ jobKey: string }>(
      "SELECT jobKey FROM automation_savings_daily WHERE jobKind='workflow' AND jobId=? AND day>=? AND day<=? LIMIT 1",
      [opts.workflowId, firstDay, lastDay],
    );
    if (!own) {
      return {
        window,
        computedAt: marker?.at ?? null,
        complete,
        boundaryEstimated: false,
        rows: [],
        total: null,
        points: [],
      };
    }
    keyFilter = "AND jobKey=?";
    params.push(own.jobKey);
  }
  const buckets = await client.query<BucketRow & { computedAt: string }>(
    `SELECT day, jobId, jobKey, jobName, computedAt, ${SAVINGS_FACT_COLUMNS.join(", ")}
     FROM automation_savings_daily
     WHERE jobKind='workflow' AND subKind='' AND modelVersion=? AND day>=? AND day<=? ${keyFilter}
     ORDER BY day`,
    params,
  );
  let computedAt = marker?.at ?? null;
  for (const b of buckets) if (!computedAt || b.computedAt > computedAt) computedAt = b.computedAt;
  const boundaryEstimated = await clipFirstDay(buckets, window, firstDay, opts.sql);
  const jobs = new Map<string, Job>();
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

  // Versions of one job share the schedule cap: the live version first, then
  // retired copies by name. A version priced by the enabled-only rule takes no
  // share of the cap.
  const allocations = new Map<string, ScheduleAllocation>();
  const byKey = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    if (isEnabledOnlyRouter(job.facts, opts.days)) continue;
    byKey.set(job.jobKey, [...(byKey.get(job.jobKey) ?? []), job]);
  }
  for (const versions of byKey.values()) {
    versions.sort(
      (a, b) =>
        Number(isRetired(a.name)) - Number(isRetired(b.name)) || a.name.localeCompare(b.name),
    );
    const shares = allocateSchedule(
      versions.map((v) => v.facts),
      opts.days,
    );
    versions.forEach((v, i) => {
      allocations.set(v.workflowId, shares[i] as ScheduleAllocation);
    });
  }

  const selected = [...jobs.values()].filter(
    (j) => !opts.workflowId || j.workflowId === opts.workflowId,
  );
  const band = selected.length === 1 ? "job" : "fleet";
  const rows: WorkflowSavingsRow[] = [];
  const totalParts: PricedWorkflow[] = [];
  for (const job of selected) {
    const pricing = { tier: opts.tier, days: opts.days };
    const allocation = allocations.get(job.workflowId);
    const priced = priceWorkflow(job.facts, { ...pricing, band: "job" }, allocation);
    rows.push({ ...priced, workflowId: job.workflowId, name: job.name });
    totalParts.push(
      band === "job" ? priced : priceWorkflow(job.facts, { ...pricing, band }, allocation),
    );
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  const only = selected.length === 1 ? selected[0] : undefined;
  const points =
    only && rows[0] ? dailyPoints(only, rows[0], calendarDays, opts.days, opts.tier) : [];
  return {
    window,
    computedAt,
    complete,
    boundaryEstimated,
    rows,
    total: totalParts.length > 0 ? sumTotals(totalParts) : null,
    points,
  };
}

/**
 * Replace each first-day bucket with the facts of the runs inside the window,
 * scanned live (the window starts mid-day). Returns whether any of them had to
 * be estimated instead.
 */
async function clipFirstDay(
  buckets: BucketRow[],
  window: SavingsWindow,
  firstDay: string,
  sql: SavingsSql = (q, p) => getDbClient().query(q, p),
): Promise<boolean> {
  if (window.start === dayStartIso(firstDay)) return false;
  const first = buckets.filter((b) => b.day === firstDay);
  if (first.length === 0) return false;
  const ids = [...new Set(first.map((b) => b.jobId))];
  const defs = await getDbClient().query<{ id: string; definition: unknown }>(
    `SELECT id, definition FROM workflows WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const defOf = new Map(defs.map((d) => [d.id, parseDefinition(d.definition)]));
  const slice = {
    start: window.start,
    end: dayStartIso(utcDay(Date.parse(window.start) + DAY_MS)),
  };
  const dayShare = (Date.parse(slice.end) - Date.parse(slice.start)) / DAY_MS;
  let estimated = false;
  await Promise.all(
    first.map(async (b) => {
      const result: SliceResult = defOf.has(b.jobId)
        ? await scanSlice({ id: b.jobId, definition: defOf.get(b.jobId) }, slice, sql)
        : { runs: null };
      let facts: WorkflowFacts;
      if ("facts" in result) {
        facts = result.facts;
      } else {
        estimated = true;
        const share =
          result.runs !== null && Number(b.runs) > 0
            ? Math.min(1, result.runs / Number(b.runs))
            : dayShare;
        facts = scaleBucket(b, share);
      }
      for (const c of SAVINGS_FACT_COLUMNS) b[c] = facts[c];
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

/** Every day of the window gets a point; days without runs are zero. */
function dailyPoints(
  job: Job,
  priced: PricedWorkflow,
  calendarDays: string[],
  windowDays: number,
  tier: SavingsTier,
): SavingsDailyPoint[] {
  const split = new Map(
    splitByDay(job.facts, job.days, { tier, days: windowDays }, priced).map((p) => [p.day, p]),
  );
  return calendarDays.map(
    (day) =>
      split.get(day) ?? { day, savingUsd: 0, actualUsd: 0, measuredUsd: 0, estimatedLlmUsd: 0 },
  );
}
