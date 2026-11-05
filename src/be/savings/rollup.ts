/**
 * Hourly rollup of the savings model into `automation_savings_daily`: one row
 * per workflow per UTC day with the tier-independent facts of
 * `computeWorkflowWindow`, and per script name the facts of
 * `computeScriptWindow` (subKind '' for non-API runs, 'api' for API runs). Each tick recomputes the days that are not final
 * yet (today and yesterday), days computed under an older MODEL_VERSION, and
 * missing days of the last ROLLUP_DAYS, newest first, within a time budget.
 * Same shape as `db-retention.ts`: single-flight tick, abort on stop, unref'd
 * timers, a catch-up tick while work is left.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getDbClient } from "../db";
import type { DbExecutor } from "../db-client";
import { computeScriptWindow, computeWorkflowWindow, type SavingsSql } from "./compute";
import { jobKey, MODEL_VERSION, type ScriptFacts, type WorkflowFacts } from "./model";

const DAY_MS = 86_400_000;
/** Days kept and backfilled: the longest window the API serves. */
export const ROLLUP_DAYS = 90;
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
const CATCHUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_TICK_BUDGET_MS = 5 * 60 * 1000;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStartIso = (day: string): string => `${day}T00:00:00.000Z`;
const dayStartMs = (day: string): number => Date.parse(dayStartIso(day));

/**
 * A day is final once computed a full day after it ended: by then the agent
 * sessions its runs started have reported their cost.
 */
export const isFinalDay = (day: string, computedAt: string): boolean =>
  Date.parse(computedAt) >= dayStartMs(day) + 2 * DAY_MS;

const FACT_COLUMNS = [
  "runs",
  "countedRuns",
  "schedRuns",
  "schedEffectRuns",
  "eventRuns",
  "effectRuns",
  "effectOpsSum",
  "opsSum",
  "agentTasks",
  "agentUsd",
  "agentMs",
  "followupUsd",
  "recordedLlmUsd",
  "estimatedLlmUsd",
  "computeSecs",
] as const satisfies readonly (keyof WorkflowFacts)[];
export { FACT_COLUMNS as SAVINGS_FACT_COLUMNS };

type WorkflowRow = { id: string; name: string; definition: unknown };
export type WorkflowBucket = { workflowId: string; name: string; facts: WorkflowFacts };

function parseDefinition(definition: unknown): unknown {
  if (typeof definition !== "string") return definition ?? {};
  try {
    return JSON.parse(definition);
  } catch {
    return {};
  }
}

async function listWorkflows(): Promise<WorkflowRow[]> {
  const rows = await getDbClient().query<WorkflowRow>(
    "SELECT id, name, definition FROM workflows ORDER BY name",
  );
  return rows.map((w) => ({ ...w, definition: parseDefinition(w.definition) }));
}

export type SavingsJobKind = "workflow" | "script";

/** Days of the last ROLLUP_DAYS that need a (re)computation, newest first. */
export async function daysToCompute(kind: SavingsJobKind, now: number): Promise<string[]> {
  const oldest = utcDay(now - (ROLLUP_DAYS - 1) * DAY_MS);
  const markers = await getDbClient().query<{
    day: string;
    modelVersion: number;
    computedAt: string;
  }>(
    "SELECT day, modelVersion, computedAt FROM automation_savings_days WHERE jobKind=? AND day>=?",
    [kind, oldest],
  );
  const byDay = new Map(markers.map((m) => [m.day, m]));
  const days: string[] = [];
  for (let i = 0; i < ROLLUP_DAYS; i++) {
    const day = utcDay(now - i * DAY_MS);
    const m = byDay.get(day);
    if (!m || Number(m.modelVersion) !== MODEL_VERSION || !isFinalDay(day, m.computedAt)) {
      days.push(day);
    }
  }
  return days;
}

export const workflowDaysToCompute = (now: number): Promise<string[]> =>
  daysToCompute("workflow", now);

/** Facts of every workflow with runs on `day`. */
export async function computeWorkflowDay(
  day: string,
  sql: SavingsSql,
  signal?: AbortSignal,
): Promise<WorkflowBucket[]> {
  const window = { start: dayStartIso(day), end: dayStartIso(utcDay(dayStartMs(day) + DAY_MS)) };
  const buckets: WorkflowBucket[] = [];
  for (const w of await listWorkflows()) {
    signal?.throwIfAborted();
    const out = await computeWorkflowWindow(w, window, sql, {
      maxRuns: Number.POSITIVE_INFINITY,
    });
    if (out.status === "ok" && out.facts.runs > 0) {
      buckets.push({ workflowId: w.id, name: w.name, facts: out.facts });
    }
  }
  return buckets;
}

const INSERT_BUCKET = `INSERT OR REPLACE INTO automation_savings_daily
  (day, jobKind, jobId, jobKey, jobName, subKind, ${FACT_COLUMNS.join(", ")}, modelVersion, computedAt)
  VALUES (?, 'workflow', ?, ?, ?, '', ${FACT_COLUMNS.map(() => "?").join(", ")}, ?, ?)`;

const bucketParams = (day: string, b: WorkflowBucket, computedAt: string) => [
  day,
  b.workflowId,
  jobKey(b.name),
  b.name,
  ...FACT_COLUMNS.map((c) => b.facts[c]),
  MODEL_VERSION,
  computedAt,
];

/** Replace one day's workflow buckets and mark the day computed, atomically. */
export async function writeWorkflowDay(
  day: string,
  buckets: WorkflowBucket[],
  computedAt: string,
): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    await tx.run("DELETE FROM automation_savings_daily WHERE day=? AND jobKind='workflow'", [day]);
    for (const b of buckets) await tx.run(INSERT_BUCKET, bucketParams(day, b, computedAt));
    await markDay(tx, day, "workflow", computedAt);
  });
}

async function markDay(
  tx: DbExecutor,
  day: string,
  kind: SavingsJobKind,
  computedAt: string,
): Promise<void> {
  await tx.run(
    `INSERT INTO automation_savings_days (day, jobKind, modelVersion, computedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, jobKind) DO UPDATE SET modelVersion=excluded.modelVersion, computedAt=excluded.computedAt`,
    [day, kind, MODEL_VERSION, computedAt],
  );
}

export type ScriptBucket = { scriptName: string; facts: ScriptFacts };

/** Facts of every script name with runs on `day`. */
export async function computeScriptDay(day: string, sql: SavingsSql): Promise<ScriptBucket[]> {
  const window = { start: dayStartIso(day), end: dayStartIso(utcDay(dayStartMs(day) + DAY_MS)) };
  const out: ScriptBucket[] = [];
  for (const s of await computeScriptWindow(window, sql)) {
    const facts: ScriptFacts = {
      runs: 0,
      apiRuns: 0,
      effectRuns: 0,
      apiEffectRuns: 0,
      opsSum: 0,
      computeSecs: 0,
    };
    for (const d of s.byDay) {
      for (const k of Object.keys(facts) as (keyof ScriptFacts)[]) facts[k] += d[k];
    }
    if (facts.runs > 0) out.push({ scriptName: s.scriptName, facts });
  }
  return out;
}

const INSERT_SCRIPT_BUCKET = `INSERT OR REPLACE INTO automation_savings_daily
  (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, effectRuns, opsSum, computeSecs, modelVersion, computedAt)
  VALUES (?, 'script', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Replace one day's script buckets and mark the day computed, atomically.
 * Each script gets a subKind '' row for its non-API runs (with the wall time
 * of all its runs) and, when it had API runs, an 'api' row for those.
 */
export async function writeScriptDay(
  day: string,
  buckets: ScriptBucket[],
  computedAt: string,
): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    await tx.run("DELETE FROM automation_savings_daily WHERE day=? AND jobKind='script'", [day]);
    for (const { scriptName, facts } of buckets) {
      const perRun = facts.runs > 0 ? facts.opsSum / facts.runs : 0;
      const nonApi = facts.runs - facts.apiRuns;
      const base = [day, scriptName, scriptName, scriptName];
      await tx.run(INSERT_SCRIPT_BUCKET, [
        ...base,
        "",
        nonApi,
        nonApi,
        facts.effectRuns,
        perRun * nonApi,
        facts.computeSecs,
        MODEL_VERSION,
        computedAt,
      ]);
      if (facts.apiRuns > 0) {
        await tx.run(INSERT_SCRIPT_BUCKET, [
          ...base,
          "api",
          facts.apiRuns,
          facts.apiRuns,
          facts.apiEffectRuns,
          perRun * facts.apiRuns,
          0,
          MODEL_VERSION,
          computedAt,
        ]);
      }
    }
    await markDay(tx, day, "script", computedAt);
  });
}

/**
 * Recompute today's bucket of one workflow when it has a run newer than the
 * last rollup of today, so a detail page shows a run within seconds instead of
 * an hour. Skipped above LIVE_MAX_RUNS runs today (the hourly tick covers
 * those) and before the rollup has computed today at all. `skipped` means no
 * scan ran; `computed` and `refused` mean the day's scans ran.
 */
export async function refreshWorkflowToday(
  workflow: WorkflowRow,
  sql: SavingsSql,
  now: number,
): Promise<"skipped" | "computed" | "refused"> {
  const day = utcDay(now);
  const client = getDbClient();
  const marker = await client.get<{ computedAt: string }>(
    "SELECT computedAt FROM automation_savings_days WHERE day=? AND jobKind='workflow' AND modelVersion=?",
    [day, MODEL_VERSION],
  );
  if (!marker) return "skipped";
  const bucket = await client.get<{ computedAt: string }>(
    "SELECT computedAt FROM automation_savings_daily WHERE day=? AND jobKind='workflow' AND jobId=? AND subKind=''",
    [day, workflow.id],
  );
  const since =
    bucket && bucket.computedAt > marker.computedAt ? bucket.computedAt : marker.computedAt;
  const newer = await client.get<{ n: number }>(
    "SELECT count(*) n FROM workflow_runs WHERE workflowId=? AND startedAt>=?",
    [workflow.id, since],
  );
  if (!Number(newer?.n)) return "skipped";
  const out = await computeWorkflowWindow(
    { id: workflow.id, definition: parseDefinition(workflow.definition) },
    { start: dayStartIso(day), end: dayStartIso(utcDay(dayStartMs(day) + DAY_MS)) },
    sql,
  );
  if (out.status !== "ok") return "refused";
  const computedAt = new Date(now).toISOString();
  await client.run(
    INSERT_BUCKET,
    bucketParams(
      day,
      { workflowId: workflow.id, name: workflow.name, facts: out.facts },
      computedAt,
    ),
  );
  return "computed";
}

export type SavingsRollupTickOptions = {
  now?: number;
  /** Wall-clock budget of one tick; days left over go to a catch-up tick. */
  budgetMs?: number;
};

export type SavingsRollupStats = {
  ticks: number;
  lastTickAt: string | null;
  daysComputed: number;
  daysPending: number;
  lastError: string | null;
};

let rollupSql: SavingsSql | null = null;
let rollupTimer: ReturnType<typeof setInterval> | null = null;
let catchupTimer: ReturnType<typeof setTimeout> | null = null;
let tickPromise: Promise<SavingsRollupStats> | null = null;
let abortController: AbortController | null = null;
let stats: SavingsRollupStats = {
  ticks: 0,
  lastTickAt: null,
  daysComputed: 0,
  daysPending: 0,
  lastError: null,
};

// Timers must not inherit a caller's AsyncLocalStorage (an open transaction).
const scheduleContextFree = AsyncLocalStorage.snapshot();

function clearCatchup(): void {
  if (catchupTimer) {
    clearTimeout(catchupTimer);
    catchupTimer = null;
  }
}

/** Run one rollup pass. Concurrent callers share the running tick. */
export function runSavingsRollupTick(
  sql: SavingsSql,
  options: SavingsRollupTickOptions = {},
): Promise<SavingsRollupStats> {
  if (tickPromise) return tickPromise;
  const controller = new AbortController();
  abortController = controller;
  const promise = Promise.resolve().then(async () => {
    clearCatchup();
    const startedAt = Date.now();
    const now = options.now ?? startedAt;
    const budget = options.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
    stats = { ...stats, ticks: stats.ticks + 1, lastTickAt: new Date(startedAt).toISOString() };
    let computed = 0;
    let pending: { kind: SavingsJobKind; day: string }[] = [];
    let lastError: string | null = null;
    try {
      const oldest = utcDay(now - (ROLLUP_DAYS - 1) * DAY_MS);
      await getDbClient().run("DELETE FROM automation_savings_daily WHERE day<?", [oldest]);
      await getDbClient().run("DELETE FROM automation_savings_days WHERE day<?", [oldest]);
      const wf = await daysToCompute("workflow", now);
      const sc = await daysToCompute("script", now);
      // Newest day first; a day's workflows before its scripts.
      pending = [
        ...wf.map((day) => ({ kind: "workflow" as const, day })),
        ...sc.map((day) => ({ kind: "script" as const, day })),
      ].sort((a, b) => b.day.localeCompare(a.day) || (a.kind === "workflow" ? -1 : 1));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    // A day that fails (a query over its budget) is retried next hour; it
    // never blocks the older days behind it.
    const failed: string[] = [];
    while (pending.length > 0 && !controller.signal.aborted && Date.now() - startedAt <= budget) {
      const { kind, day } = pending.shift() as { kind: SavingsJobKind; day: string };
      try {
        const at = () => new Date(options.now ?? Date.now()).toISOString();
        if (kind === "workflow") {
          const buckets = await computeWorkflowDay(day, sql, controller.signal);
          await writeWorkflowDay(day, buckets, at());
        } else {
          const buckets = await computeScriptDay(day, sql);
          await writeScriptDay(day, buckets, at());
        }
        computed += 1;
      } catch (err) {
        if (controller.signal.aborted) break;
        failed.push(`${kind}:${day}`);
        lastError = `${kind} ${day}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (lastError) console.warn(`[savings-rollup] ${lastError.slice(0, 300)}`);
    stats = { ...stats, lastError };
    stats = {
      ...stats,
      daysComputed: stats.daysComputed + computed,
      daysPending: pending.length + failed.length,
    };
    // Work left and progress made: continue soon instead of in an hour.
    if (rollupTimer && pending.length > 0 && computed > 0 && !controller.signal.aborted) {
      catchupTimer = scheduleContextFree(() =>
        setTimeout(() => {
          catchupTimer = null;
          if (rollupSql) void runSavingsRollupTick(rollupSql);
        }, CATCHUP_INTERVAL_MS),
      );
      if (typeof catchupTimer.unref === "function") catchupTimer.unref();
    }
    return { ...stats };
  });
  const tracked: Promise<SavingsRollupStats> = promise.finally(() => {
    if (tickPromise === tracked) tickPromise = null;
    if (abortController === controller) abortController = null;
  });
  tickPromise = tracked;
  return tracked;
}

export function getSavingsRollupStats(): SavingsRollupStats {
  return { ...stats };
}

/**
 * Start the hourly rollup. The first tick runs in the background: a fresh
 * deployment backfills ROLLUP_DAYS days over several catch-up ticks.
 */
export function startSavingsRollup(sql: SavingsSql, intervalMs = ROLLUP_INTERVAL_MS): void {
  if (rollupTimer) return;
  rollupSql = sql;
  rollupTimer = scheduleContextFree(() =>
    setInterval(() => void runSavingsRollupTick(sql), intervalMs),
  );
  if (typeof rollupTimer.unref === "function") rollupTimer.unref();
  void runSavingsRollupTick(sql);
}

export async function stopSavingsRollup(): Promise<void> {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
  clearCatchup();
  abortController?.abort();
  await tickPromise?.catch(() => undefined);
}

/** Test hook to keep module state from leaking between test files. */
export async function resetSavingsRollupForTests(): Promise<void> {
  await stopSavingsRollup();
  rollupSql = null;
  stats = { ticks: 0, lastTickAt: null, daysComputed: 0, daysPending: 0, lastError: null };
}
