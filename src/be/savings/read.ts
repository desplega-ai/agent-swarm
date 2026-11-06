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
import { computeScriptSlice, dayStartIso, SAVINGS_FACT_COLUMNS, utcDay } from "./rollup";

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
  childTaskUsd: 0,
  childTaskMs: 0,
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
  return fillDays(
    splitByDay(job.facts, job.days, { tier, days: windowDays }, priced),
    calendarDays,
  );
}

function fillDays(points: SavingsDailyPoint[], calendarDays: string[]): SavingsDailyPoint[] {
  const split = new Map(points.map((p) => [p.day, p]));
  return calendarDays.map(
    (day) =>
      split.get(day) ?? { day, savingUsd: 0, actualUsd: 0, measuredUsd: 0, estimatedLlmUsd: 0 },
  );
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
  /** Runs the live scan of the window's partial first day. */
  sql?: SavingsSql;
}): Promise<ScriptSavingsRead> {
  const client = getDbClient();
  const { firstDay, lastDay, ...window } = savingsWindow(opts.days, opts.now);
  const calendarDays = daysBetween(firstDay, lastDay);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= calendarDays.length;
  const params: DbParam[] = [MODEL_VERSION, firstDay, lastDay];
  if (opts.scriptName !== undefined) params.push(opts.scriptName);
  const buckets = await client.query<ScriptBucketRow>(
    `SELECT day, jobId, subKind, computedAt, runs, effectRuns, opsSum, computeSecs
     FROM automation_savings_daily
     WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=? ${opts.scriptName !== undefined ? "AND jobId=?" : ""}
     ORDER BY day`,
    params,
  );
  let computedAt = marker?.at ?? null;
  const jobs = new Map<string, { facts: ScriptFacts; days: Map<string, ScriptFacts> }>();
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
  const boundaryEstimated = await clipScriptFirstDay(jobs, window, firstDay, opts);
  const scheduled = new Set(
    (
      await client.query<{ scriptName: string }>(
        "SELECT DISTINCT scriptName FROM scheduled_tasks WHERE targetType='script' AND scriptName IS NOT NULL",
      )
    ).map((r) => r.scriptName),
  );

  const band = jobs.size === 1 ? "job" : "fleet";
  const rows: ScriptSavingsRow[] = [];
  const totalParts: PricedWorkflow[] = [];
  for (const [scriptName, job] of jobs) {
    const kind: ScriptKind = scheduled.has(scriptName)
      ? "script-scheduled"
      : "script-agent-invoked";
    const pricing = { tier: opts.tier, days: opts.days, kind };
    const priced = priceScript(job.facts, { ...pricing, band: "job" });
    rows.push({ ...priced, kind, scriptName, name: scriptName });
    totalParts.push(band === "job" ? priced : priceScript(job.facts, { ...pricing, band }));
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  const [only] = jobs.values();
  const points =
    jobs.size === 1 && only && rows[0]
      ? fillDays(
          splitScriptByDay(
            only.facts,
            [...only.days].map(([day, f]) => ({ ...f, day })),
            rows[0],
          ),
          calendarDays,
        )
      : [];
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

/** Deepest run tree the "with components" view follows. */
export const MAX_COMPONENT_DEPTH = 10;

export type SavingsComponent = {
  kind: "workflow" | "script" | "task";
  /** Set for workflow components. */
  workflowId?: string;
  /** Set for script components. */
  scriptName?: string;
  name: string;
  /** How the nearest occurrence below the root is linked. */
  linkKind: SavingsLinkKind;
  /** 1 for a direct child of the root. */
  depth: number;
  /** Runs (tasks for a task component) in this tree. Fractional below the first level. */
  runs: number;
  actualUsd: number;
  agentOnlyUsd: SavingsBand;
  savingUsd: SavingsBand;
  hoursSaved: SavingsBand;
  /**
   * Tasks the root caused without owning them: their spend is already in the
   * root's own row, on both sides, so they add nothing here.
   */
  inOwnRow: boolean;
};

type SavingsLinkKind =
  | "sub-workflow"
  | "step-workflow"
  | "step-script"
  | "step-task"
  | "descendant-task";

export type WorkflowComponentsRead = {
  components: SavingsComponent[];
  /** Own runs plus every component's share; null when the root has no row. */
  withComponents: SavingsTotals | null;
};

const scaleBand = (b: SavingsBand, f: number): SavingsBand => ({
  p10: b.p10 * f,
  p50: b.p50 * f,
  p90: b.p90 * f,
});

/** A share `f` of a priced row: its per-run figures times the linked runs. */
function scaleRow(row: PricedWorkflow, f: number): PricedWorkflow {
  return {
    ...row,
    runs: row.runs * f,
    substitutedRuns: row.substitutedRuns * f,
    enabledOnlyRuns: row.enabledOnlyRuns * f,
    effectRuns: row.effectRuns * f,
    measuredUsd: row.measuredUsd * f,
    estimatedLlmUsd: row.estimatedLlmUsd * f,
    actualUsd: row.actualUsd * f,
    agentOnlyUsd: scaleBand(row.agentOnlyUsd, f),
    savingUsd: scaleBand(row.savingUsd, f),
    actualHours: row.actualHours * f,
    agentOnlyHours: scaleBand(row.agentOnlyHours, f),
    hoursSaved: scaleBand(row.hoursSaved, f),
  };
}

const zeroBand = (): SavingsBand => ({ p10: 0, p50: 0, p90: 0 });
const addBand = (a: SavingsBand, b: SavingsBand): SavingsBand => ({
  p10: a.p10 + b.p10,
  p50: a.p50 + b.p50,
  p90: a.p90 + b.p90,
});

/**
 * The workflow's run tree for the window: every workflow run, nested script
 * run and unowned task its runs caused, recursively (depth at most
 * MAX_COMPONENT_DEPTH, never re-entering a workflow already on the path).
 * Each component is priced as on its own row: that row's figures per run
 * times the runs linked into this tree. A child workflow's own links count in
 * the share of its runs this tree started. The sum is a read-time view: no
 * list or fleet total adds it, since every component is on its own row.
 */
export async function readWorkflowComponents(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  workflowId: string;
  /** The root's own row, as the single-workflow read priced it. */
  own: WorkflowSavingsRow;
}): Promise<WorkflowComponentsRead> {
  const { firstDay, lastDay, start } = savingsWindow(opts.days, opts.now);
  // The window starts mid-way through its first UTC day; links are stored per
  // day, so that day counts by the share of it inside the window.
  // shortcut: a day-share estimate, not a live scan; scan the first day's links
  // like the rows do if component figures near the boundary need to be exact.
  const firstDayShare =
    (Date.parse(dayStartIso(utcDay(Date.parse(start) + DAY_MS))) - Date.parse(start)) / DAY_MS;
  const [workflows, scripts, links] = await Promise.all([
    readWorkflowSavings({ days: opts.days, tier: opts.tier, now: opts.now }),
    readScriptSavings({ days: opts.days, tier: opts.tier, now: opts.now }),
    getDbClient().query<{
      parentJobId: string;
      childKind: "workflow" | "script" | "task";
      childJobId: string;
      linkKind: SavingsLinkKind;
      n: number;
      usd: number;
    }>(
      `SELECT parentJobId, childKind, childJobId, linkKind,
         sum(CASE WHEN day=? THEN n*? ELSE n END) n,
         sum(CASE WHEN day=? THEN actualUsd*? ELSE actualUsd END) usd
       FROM automation_savings_links WHERE modelVersion=? AND day>=? AND day<=?
       GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
      [firstDay, firstDayShare, firstDay, firstDayShare, MODEL_VERSION, firstDay, lastDay],
    ),
  ]);
  const workflowRows = new Map(workflows.rows.map((r) => [r.workflowId, r]));
  workflowRows.set(opts.workflowId, opts.own);
  const scriptRows = new Map(scripts.rows.map((r) => [r.scriptName, r]));
  const children = new Map<string, typeof links>();
  for (const l of links) children.set(l.parentJobId, [...(children.get(l.parentJobId) ?? []), l]);

  const components = new Map<string, SavingsComponent>();
  const parts: PricedWorkflow[] = [];
  const addComponent = (
    c: Omit<SavingsComponent, "actualUsd" | "agentOnlyUsd" | "savingUsd" | "hoursSaved">,
    priced: PricedWorkflow | null,
    taskUsd = 0,
  ) => {
    const key = `${c.kind}\u0000${c.workflowId ?? c.scriptName ?? c.linkKind}`;
    const prev = components.get(key);
    components.set(key, {
      ...c,
      linkKind: prev && prev.depth <= c.depth ? prev.linkKind : c.linkKind,
      depth: Math.min(prev?.depth ?? c.depth, c.depth),
      runs: (prev?.runs ?? 0) + c.runs,
      actualUsd: (prev?.actualUsd ?? 0) + (priced?.actualUsd ?? taskUsd),
      agentOnlyUsd: addBand(prev?.agentOnlyUsd ?? zeroBand(), priced?.agentOnlyUsd ?? zeroBand()),
      savingUsd: addBand(prev?.savingUsd ?? zeroBand(), priced?.savingUsd ?? zeroBand()),
      hoursSaved: addBand(prev?.hoursSaved ?? zeroBand(), priced?.hoursSaved ?? zeroBand()),
    });
    if (priced) parts.push(priced);
  };

  const walk = (parent: string, share: number, depth: number, path: Set<string>) => {
    for (const l of children.get(parent) ?? []) {
      const linked = Number(l.n) * share;
      if (l.childKind === "task") {
        // Only the root's: a child workflow's unowned tasks are in its row already.
        if (depth === 1 && linked > 0) {
          addComponent(
            {
              kind: "task",
              name:
                l.linkKind === "step-task"
                  ? "Tasks its script steps created"
                  : "Tasks below its agent tasks",
              linkKind: l.linkKind,
              depth,
              runs: linked,
              inOwnRow: true,
            },
            null,
            Number(l.usd) * share,
          );
        }
        continue;
      }
      // A cycle back to a workflow on the path is that workflow's own row: skip it.
      if (linked <= 0 || (l.childKind === "workflow" && path.has(l.childJobId))) continue;
      const row =
        l.childKind === "workflow" ? workflowRows.get(l.childJobId) : scriptRows.get(l.childJobId);
      const f = row && row.runs > 0 ? linked / row.runs : 0;
      addComponent(
        {
          kind: l.childKind,
          ...(l.childKind === "workflow"
            ? { workflowId: l.childJobId }
            : { scriptName: l.childJobId }),
          name: row?.name ?? l.childJobId,
          linkKind: l.linkKind,
          depth,
          runs: linked,
          inOwnRow: false,
        },
        row ? scaleRow(row, f) : null,
      );
      if (l.childKind === "workflow" && f > 0 && depth < MAX_COMPONENT_DEPTH) {
        walk(l.childJobId, Math.min(1, f), depth + 1, new Set([...path, l.childJobId]));
      }
    }
  };
  walk(opts.workflowId, 1, 1, new Set([opts.workflowId]));

  const list = [...components.values()].sort(
    (a, b) =>
      Number(a.inOwnRow) - Number(b.inOwnRow) ||
      a.depth - b.depth ||
      b.savingUsd.p50 - a.savingUsd.p50,
  );
  return { components: list, withComponents: sumTotals([opts.own, ...parts]) };
}

/**
 * Replace each script's first-day facts with those of its runs inside the
 * window, scanned live (the window starts mid-day), and drop scripts left with
 * no runs. When the scan fails, the day is scaled by the share of it inside the
 * window instead; returns whether that happened.
 * shortcut: one uncached scan per read; cache it per window minute like the workflow slices if script reads get hot.
 */
async function clipScriptFirstDay(
  jobs: Map<string, { facts: ScriptFacts; days: Map<string, ScriptFacts> }>,
  window: SavingsWindow,
  firstDay: string,
  opts: { scriptName?: string; sql?: SavingsSql },
): Promise<boolean> {
  if (window.start === dayStartIso(firstDay)) return false;
  if (![...jobs.values()].some((j) => j.days.has(firstDay))) return false;
  const slice = {
    start: window.start,
    end: dayStartIso(utcDay(Date.parse(window.start) + DAY_MS)),
  };
  const sql: SavingsSql = opts.sql ?? ((q, p) => getDbClient().query(q, p));
  let live: Map<string, ScriptFacts> | null = null;
  try {
    const scanned = await computeScriptSlice(slice, sql, { scriptName: opts.scriptName });
    live = new Map(scanned.map((b) => [b.scriptName, b.facts]));
  } catch (err) {
    console.warn(
      `[savings-read] first-day script scan failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
    );
  }
  const dayShare = (Date.parse(slice.end) - Date.parse(slice.start)) / DAY_MS;
  for (const [name, job] of jobs) {
    const old = job.days.get(firstDay);
    if (!old) continue;
    const clipped = live ? (live.get(name) ?? zeroScriptFacts()) : scaleScriptFacts(old, dayShare);
    for (const k of Object.keys(old) as (keyof ScriptFacts)[]) {
      job.facts[k] += clipped[k] - old[k];
    }
    job.days.set(firstDay, clipped);
    if (!(job.facts.runs > 0)) jobs.delete(name);
  }
  return live === null;
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
