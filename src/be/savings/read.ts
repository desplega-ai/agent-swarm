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
  const split = new Map(
    splitByDay(job.facts, job.days, { tier, days: windowDays }, priced).map((p) => [p.day, p]),
  );
  return Array.from({ length: windowDays }, (_, i) => {
    const day = utcDay(Date.parse(dayStartIso(firstDay)) + i * DAY_MS);
    return (
      split.get(day) ?? { day, savingUsd: 0, actualUsd: 0, measuredUsd: 0, estimatedLlmUsd: 0 }
    );
  });
}
