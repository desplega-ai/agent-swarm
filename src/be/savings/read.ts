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
  /** p50 per UTC day of the window, oldest first; they add up to the row. Only for a single workflow. */
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
 * the schedule cap).
 */
export async function readWorkflowSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  workflowId?: string;
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
  const points = only && rows[0] ? dailyPoints(only, rows[0], firstDay, opts.days, opts.tier) : [];
  return {
    window,
    computedAt,
    complete,
    rows,
    total: totalParts.length > 0 ? sumTotals(totalParts) : null,
    points,
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

/** Every day of the window gets a point; days without runs are zero. */
function dailyPoints(
  job: Job,
  priced: PricedWorkflow,
  firstDay: string,
  windowDays: number,
  tier: SavingsTier,
): SavingsDailyPoint[] {
  return fillDays(
    splitByDay(job.facts, job.days, { tier, days: windowDays }, priced),
    firstDay,
    windowDays,
  );
}

function fillDays(
  points: SavingsDailyPoint[],
  firstDay: string,
  windowDays: number,
): SavingsDailyPoint[] {
  const split = new Map(points.map((p) => [p.day, p]));
  return Array.from({ length: windowDays }, (_, i) => {
    const day = utcDay(Date.parse(dayStartIso(firstDay)) + i * DAY_MS);
    return (
      split.get(day) ?? { day, savingUsd: 0, actualUsd: 0, measuredUsd: 0, estimatedLlmUsd: 0 }
    );
  });
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
          firstDay,
          opts.days,
        )
      : [];
  return {
    window,
    computedAt,
    complete,
    rows,
    total: totalParts.length > 0 ? sumTotals(totalParts) : null,
    points,
  };
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
  const base = { days: opts.days, tier: opts.tier, now: opts.now };

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
