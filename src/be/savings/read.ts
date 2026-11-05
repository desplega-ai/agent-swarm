/**
 * Read path of the savings rollup: sums the daily buckets of a window, shares
 * the schedule cap across the versions of a job, applies the enabled-only rule
 * and prices at the requested tier. All of that happens at read time, so a
 * tier or window change needs no recomputation.
 */
import { getDbClient } from "../db";
import type { DbParam } from "../db-client";
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
import { dayStartIso, SAVINGS_FACT_COLUMNS, utcDay } from "./rollup";

const DAY_MS = 86_400_000;

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
  rows: WorkflowSavingsRow[];
  total: SavingsTotals | null;
  /** p50 per UTC day of the window, oldest first, summed over the rows; they add up to the total. */
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

/** The window: the last `days` UTC days, today included, ending now. */
export function savingsWindow(days: number, now: number): SavingsWindow & { firstDay: string } {
  const firstDay = utcDay(now - (days - 1) * DAY_MS);
  return { start: dayStartIso(firstDay), end: new Date(now).toISOString(), days, firstDay };
}

const isRetired = (name: string) => /-retired-\d{4}-\d{2}-\d{2}$/.test(name);

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
}): Promise<WorkflowSavingsRead> {
  const client = getDbClient();
  const { firstDay, ...window } = savingsWindow(opts.days, opts.now);
  const lastDay = utcDay(opts.now);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='workflow' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= opts.days;

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
  const jobs = new Map<string, Job>();
  for (const b of buckets) {
    if (!computedAt || b.computedAt > computedAt) computedAt = b.computedAt;
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
  const band = opts.band ?? (selected.length === 1 ? "job" : "fleet");
  const rows: WorkflowSavingsRow[] = [];
  const totalParts: PricedWorkflow[] = [];
  const dayParts: SavingsDailyPoint[][] = [];
  for (const job of selected) {
    const pricing = { tier: opts.tier, days: opts.days };
    const allocation = allocations.get(job.workflowId);
    const priced = priceWorkflow(job.facts, { ...pricing, band: "job" }, allocation);
    rows.push({ ...priced, workflowId: job.workflowId, name: job.name });
    totalParts.push(
      band === "job" ? priced : priceWorkflow(job.facts, { ...pricing, band }, allocation),
    );
    dayParts.push(splitByDay(job.facts, job.days, pricing, priced));
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  return {
    window,
    computedAt,
    complete,
    rows,
    total: totalParts.length > 0 ? sumTotals(totalParts) : null,
    points: rows.length > 0 ? fillDays(dayParts.flat(), firstDay, opts.days) : [],
  };
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

/** One point per day of the window, adding up the points of each day; days without runs are zero. */
function fillDays(
  points: SavingsDailyPoint[],
  firstDay: string,
  windowDays: number,
): SavingsDailyPoint[] {
  const days = Array.from({ length: windowDays }, (_, i) => {
    const day = utcDay(Date.parse(dayStartIso(firstDay)) + i * DAY_MS);
    return { day, savingUsd: 0, actualUsd: 0, measuredUsd: 0, estimatedLlmUsd: 0 };
  });
  const byDay = new Map(days.map((p) => [p.day, p]));
  for (const p of points) {
    const d = byDay.get(p.day);
    if (!d) continue;
    d.savingUsd += p.savingUsd;
    d.actualUsd += p.actualUsd;
    d.measuredUsd += p.measuredUsd;
    d.estimatedLlmUsd += p.estimatedLlmUsd;
  }
  return days;
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
}): Promise<ScriptSavingsRead> {
  const client = getDbClient();
  const { firstDay, ...window } = savingsWindow(opts.days, opts.now);
  const lastDay = utcDay(opts.now);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= opts.days;
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
  const scheduled = new Set(
    (
      await client.query<{ scriptName: string }>(
        "SELECT DISTINCT scriptName FROM scheduled_tasks WHERE targetType='script' AND scriptName IS NOT NULL",
      )
    ).map((r) => r.scriptName),
  );

  const band = opts.band ?? (jobs.size === 1 ? "job" : "fleet");
  const rows: ScriptSavingsRow[] = [];
  const totalParts: PricedWorkflow[] = [];
  const dayParts: SavingsDailyPoint[][] = [];
  for (const [scriptName, job] of jobs) {
    const kind: ScriptKind = scheduled.has(scriptName)
      ? "script-scheduled"
      : "script-agent-invoked";
    const pricing = { tier: opts.tier, days: opts.days, kind };
    const priced = priceScript(job.facts, { ...pricing, band: "job" });
    rows.push({ ...priced, kind, scriptName, name: scriptName });
    totalParts.push(band === "job" ? priced : priceScript(job.facts, { ...pricing, band }));
    dayParts.push(
      splitScriptByDay(
        job.facts,
        [...job.days].map(([day, f]) => ({ ...f, day })),
        priced,
      ),
    );
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  return {
    window,
    computedAt,
    complete,
    rows,
    total: totalParts.length > 0 ? sumTotals(totalParts) : null,
    points: rows.length > 0 ? fillDays(dayParts.flat(), firstDay, opts.days) : [],
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
}): Promise<FleetSavingsRead> {
  const wf = await readWorkflowSavings({ ...opts, band: "fleet" });
  const sc = await readScriptSavings({ ...opts, band: "fleet" });
  const all: PricedWorkflow[] = [...wf.rows, ...sc.rows];
  const total =
    all.length === 1
      ? sumTotals(all)
      : wf.total && sc.total
        ? addTotals(wf.total, sc.total)
        : (wf.total ?? sc.total);
  const points =
    all.length > 0
      ? fillDays(
          [...wf.points, ...sc.points],
          savingsWindow(opts.days, opts.now).firstDay,
          opts.days,
        )
      : [];
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
