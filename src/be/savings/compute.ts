/**
 * Live facts for one workflow over a window, read from workflow_runs, steps,
 * agent tasks and session costs. The SQL is ported from the
 * `automation-savings-estimate` script (v7); pricing lives in `model.ts`.
 */
import { getDbClient } from "../db";
import type { DbParam } from "../db-client";
import {
  DEFAULT_OPS,
  INLINE_OPS,
  INLINE_SCRIPT_NAME,
  JEV_PER_M,
  nodeOpsOf,
  type ScriptFacts,
  scriptOpsFromAwaitCount,
  type WorkflowFacts,
} from "./model";

/** Runs a read query. The default is the API's own DB client. */
export type SavingsSql = <T>(sql: string, params: DbParam[]) => Promise<T[]>;

const defaultSql: SavingsSql = (sql, params) => getDbClient().query(sql, params);

/**
 * Above this many runs in the window a live (on-request) computation refuses:
 * the router has 12k to 30k runs a day and its step scan alone takes seconds.
 * The daily rollup has no limit: it runs off the request path, one day at a time.
 */
export const LIVE_MAX_RUNS = 10_000;

export type WorkflowWindow =
  | { status: "ok"; facts: WorkflowFacts; byDay: DayFacts[] }
  | { status: "too-many-runs"; runs: number };

/** One UTC day's facts. The window's facts are the sum over its days. */
export type DayFacts = WorkflowFacts & { day: string };

// A run "caused a downstream effect" when it created an agent task or started a child workflow run.
const EFFECT_SQL =
  "(EXISTS(SELECT 1 FROM agent_tasks k WHERE k.workflowRunId=r.id) OR EXISTS(SELECT 1 FROM workflow_run_steps s2 JOIN workflow_runs c ON c.parentStepId=s2.id WHERE s2.runId=r.id))";
const AWAITS_SQL = "(length(source)-length(replace(source,'await','')))/5";

const num = (v: unknown): number => Number(v) || 0;

export const emptyFacts = (runs: number): WorkflowFacts => ({
  runs,
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

/** Ops per script name; a global script wins over an agent-scoped one of the same name. */
async function scriptOps(names: string[], sql: SavingsSql): Promise<Map<string, number>> {
  const ops = new Map<string, number>();
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return ops;
  // Chunked: a day can have over a thousand script names.
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await sql<{ name: string; aw: number }>(
      `SELECT name, ${AWAITS_SQL} aw FROM scripts WHERE isScratch=0 AND name IN (${chunk.map(() => "?").join(",")}) ORDER BY scope='global'`,
      chunk,
    );
    for (const row of rows) ops.set(row.name, scriptOpsFromAwaitCount(row.aw));
  }
  return ops;
}

/**
 * How runs are grouped: by UTC day (`YYYY-MM-DD`), or by UTC minute
 * (`YYYY-MM-DDTHH:MM`) so a reader can drop the runs before a window start
 * that falls inside the scanned slice.
 */
export type SavingsBucket = "day" | "minute";

/** The SQL key of an ISO `startedAt` column for `bucket`. */
function bucketSql(column: string, bucket: SavingsBucket = "day"): string {
  return `substr(${column},1,${bucket === "minute" ? 16 : 10})`;
}

/** Every run's facts, grouped by the UTC day (or minute) it started; the window facts are their sum. */
export async function computeWorkflowWindow(
  workflow: { id: string; definition: unknown },
  window: { start: string; end: string },
  sql: SavingsSql = defaultSql,
  opts: { maxRuns?: number; bucket?: SavingsBucket } = {},
): Promise<WorkflowWindow> {
  const DAY_SQL = bucketSql("r.startedAt", opts.bucket);
  const span = [workflow.id, window.start, window.end];
  const maxRuns = opts.maxRuns ?? LIVE_MAX_RUNS;
  // Index-only count first, so a high-volume workflow never reaches the step scans.
  const total = num(
    (
      await sql<{ n: number }>(
        "SELECT count(*) n FROM workflow_runs WHERE workflowId=? AND startedAt>=? AND startedAt<?",
        span,
      )
    )[0]?.n,
  );
  if (total === 0) return { status: "ok", facts: emptyFacts(0), byDay: [] };
  if (total > maxRuns) return { status: "too-many-runs", runs: total };

  const days = new Map<string, DayFacts>();
  const dayOf = (d: unknown): DayFacts => {
    const key = String(d);
    let f = days.get(key);
    if (!f) {
      f = { day: key, ...emptyFacts(0) };
      days.set(key, f);
    }
    return f;
  };

  const byTrigger = await sql<{ d: string; tt: string; st: string; n: number }>(
    // Without the hint the planner picks the triggerType index and scans every run.
    `SELECT ${DAY_SQL} d, r.triggerType tt, r.status st, count(*) n FROM workflow_runs r INDEXED BY idx_workflow_runs_workflow_started WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? GROUP BY 1,2,3`,
    span,
  );
  let schedRuns = 0;
  for (const row of byTrigger) {
    const f = dayOf(row.d);
    const n = num(row.n);
    f.runs += n;
    if (row.tt === "event") f.eventRuns += n;
    if (row.st === "skipped" || row.st === "cancelled") continue;
    f.countedRuns += n;
    if (row.tt === "schedule") {
      f.schedRuns += n;
      schedRuns += n;
    }
  }
  if (schedRuns > 0) {
    const effect = await sql<{ d: string; n: number }>(
      `SELECT ${DAY_SQL} d, count(*) n FROM workflow_runs r WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? AND r.triggerType='schedule' AND r.status NOT IN ('skipped','cancelled') AND ${EFFECT_SQL} GROUP BY 1`,
      span,
    );
    for (const row of effect) dayOf(row.d).schedEffectRuns += num(row.n);
  }

  const definition = (workflow.definition ?? {}) as {
    nodes?: { id: string; type: string; config?: Record<string, unknown> }[];
  };
  const scriptNames = (definition.nodes ?? [])
    .filter((n) => n.type === "swarm-script")
    .map((n) => n.config?.scriptName)
    .filter((n): n is string => typeof n === "string");
  const nodeOps = nodeOpsOf(definition, await scriptOps(scriptNames, sql));

  const steps = await sql<{
    d: string;
    nid: string;
    n: number;
    secs: number | null;
    itok: number | null;
    rchars: number | null;
    jev: number | null;
    clairic: number | null;
  }>(
    `SELECT ${DAY_SQL} d, s.nodeId nid, count(*) n, sum(CASE WHEN s.nodeType NOT IN ('agent-task','wait','human-in-the-loop','foreach','sub-workflow') THEN (julianday(coalesce(s.finishedAt,s.startedAt))-julianday(s.startedAt))*86400 ELSE 0 END) secs,
      sum(CASE WHEN s.nodeType LIKE 'system-one%' THEN json_extract(s.output,'$.usage.input_tokens') END) itok,
      sum(CASE WHEN s.nodeType='raw-llm' THEN length(json_extract(s.output,'$.result')) END) rchars,
      sum(CASE WHEN s.nodeId='report' THEN json_extract(s.output,'$.result.summary.jevCostUsd') END) jev,
      sum(CASE WHEN s.nodeId='report' THEN json_extract(s.output,'$.result.cost.clairicUsd') END) clairic
      FROM workflow_runs r JOIN workflow_run_steps s ON s.runId=r.id WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? GROUP BY 1,2`,
    span,
  );
  for (const x of steps) {
    const f = dayOf(x.d);
    // foreach iterations store `<nodeId>#<i>`.
    f.opsSum += (nodeOps.get(String(x.nid).split("#")[0] ?? "") ?? 0) * num(x.n);
    f.recordedLlmUsd += num(x.jev) + num(x.clairic);
    f.estimatedLlmUsd += (num(x.itok) / 1e6) * JEV_PER_M + (num(x.rchars) * (1.2 / 4 + 0.3)) / 1e6;
    f.computeSecs += num(x.secs);
  }

  const agent = await sql<{ d: string; tasks: number; usd: number | null; ms: number | null }>(
    `SELECT ${DAY_SQL} d, count(DISTINCT t.id) tasks, sum(c.u) usd, sum(c.ms) ms
      FROM workflow_runs r JOIN agent_tasks t ON t.workflowRunId=r.id LEFT JOIN (SELECT taskId, sum(totalCostUsd) u, sum(durationMs) ms FROM session_costs GROUP BY taskId) c ON c.taskId=t.id
      WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? GROUP BY 1`,
    span,
  );
  for (const row of agent) {
    const f = dayOf(row.d);
    f.agentTasks += num(row.tasks);
    f.agentUsd += num(row.usd);
    f.agentMs += num(row.ms);
  }
  const followups = await sql<{ d: string; fup: number | null }>(
    `SELECT ${DAY_SQL} d, sum(c2.totalCostUsd) fup FROM workflow_runs r JOIN agent_tasks t2 ON t2.workflowRunId=r.id JOIN agent_tasks k ON k.parentTaskId=t2.id AND (k.task LIKE 'Worker task completed%' OR k.task LIKE 'Worker task failed%') JOIN session_costs c2 ON c2.taskId=k.id WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? GROUP BY 1`,
    span,
  );
  for (const row of followups) dayOf(row.d).followupUsd += num(row.fup);

  // Effect runs of any trigger, found from the child side (child runs via
  // parentStepId, tasks via workflowRunId), with the steps of those runs:
  // the enabled-only rule prices only these.
  const effect = await sql<{ d: string; nid: string | null; n: number }>(
    `WITH e AS (SELECT s.runId id FROM workflow_runs c INDEXED BY idx_workflow_runs_parentStep_attempt JOIN workflow_run_steps s ON s.id=c.parentStepId JOIN workflow_runs p ON p.id=s.runId
        WHERE c.parentStepId IS NOT NULL AND p.workflowId=? AND p.startedAt>=? AND p.startedAt<?
      UNION SELECT k.workflowRunId FROM agent_tasks k INDEXED BY idx_agent_tasks_workflow_run JOIN workflow_runs p ON p.id=k.workflowRunId WHERE k.workflowRunId IS NOT NULL AND p.workflowId=? AND p.startedAt>=? AND p.startedAt<?),
    ed AS (SELECT e.id, ${DAY_SQL} d FROM e JOIN workflow_runs r ON r.id=e.id)
    SELECT d, NULL nid, count(*) n FROM ed GROUP BY d
    UNION ALL SELECT ed.d, s.nodeId, count(*) n FROM ed JOIN workflow_run_steps s ON s.runId=ed.id GROUP BY 1,2`,
    [...span, ...span],
  );
  for (const row of effect) {
    const f = dayOf(row.d);
    // The row with no node id carries the day's effect-run count.
    if (row.nid === null) f.effectRuns += num(row.n);
    else f.effectOpsSum += (nodeOps.get(String(row.nid).split("#")[0] ?? "") ?? 0) * num(row.n);
  }

  const byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const facts = emptyFacts(0);
  for (const f of byDay) {
    for (const k of Object.keys(facts) as (keyof WorkflowFacts)[]) facts[k] += f[k];
  }
  return { status: "ok", facts, byDay };
}

/** One script's facts per UTC day. */
export type ScriptDayFacts = ScriptFacts & { day: string };
export type ScriptWindowFacts = { scriptName: string; byDay: ScriptDayFacts[] };

/** Source that can create an agent task or start a workflow; only these scripts are probed for effects. */
const DISPATCH_SQL =
  "(source LIKE '%task_send%' OR source LIKE '%send_task%' OR source LIKE '%sendTask%' OR source LIKE '%workflow_trigger%')";

/** The script_runs filter of a window, narrowed to one script name (runs without one by INLINE_SCRIPT_NAME). */
function scriptRunsFilter(
  window: { start: string; end: string },
  opts: { scriptName?: string },
): { where: string; params: string[] } {
  const span = [window.start, window.end];
  return opts.scriptName === undefined
    ? { where: "", params: span }
    : {
        where: "AND coalesce(scriptName, ?)=?",
        params: [...span, INLINE_SCRIPT_NAME, opts.scriptName],
      };
}

/** Runs of every script (or of one script) in the window. */
export async function countScriptRuns(
  window: { start: string; end: string },
  sql: SavingsSql = defaultSql,
  opts: { scriptName?: string } = {},
): Promise<number> {
  const { where, params } = scriptRunsFilter(window, opts);
  const rows = await sql<{ n: number }>(
    `SELECT count(*) n FROM script_runs WHERE startedAt>=? AND startedAt<? ${where}`,
    params,
  );
  return num(rows[0]?.n);
}

/**
 * Facts of every script with runs in the window (or of one script), grouped by
 * the UTC day (or minute) the runs started. Ported from v7 `scriptJobs`: runs are keyed by
 * `scriptName` (runs without one by INLINE_SCRIPT_NAME), ops are the `await`
 * count of the catalog source (the global row wins), and a run had an effect
 * when its output names an agent task created while it ran (up to 20 minutes
 * after it started), counted on the day the run started. v7 folds names beyond its first 900 into a tail row; here
 * every name keeps its own row and ops.
 */
export async function computeScriptWindow(
  window: { start: string; end: string },
  sql: SavingsSql = defaultSql,
  opts: { scriptName?: string; bucket?: SavingsBucket } = {},
): Promise<ScriptWindowFacts[]> {
  const span = [window.start, window.end];
  const { where, params } = scriptRunsFilter(window, opts);
  const runs = await sql<{ d: string; nm: string; n: number; api: number; secs: number | null }>(
    `SELECT ${bucketSql("startedAt", opts.bucket)} d, coalesce(scriptName,'${INLINE_SCRIPT_NAME}') nm, count(*) n, sum(apiEndpointId IS NOT NULL) api,
      sum((julianday(coalesce(finishedAt,startedAt))-julianday(startedAt))*86400) secs
      FROM script_runs WHERE startedAt>=? AND startedAt<? ${where} GROUP BY 1,2`,
    params,
  );
  if (runs.length === 0) return [];
  const names = [...new Set(runs.map((r) => String(r.nm)))].filter((n) => n !== INLINE_SCRIPT_NAME);
  const ops = await scriptOps(names, sql);

  const dispatchers: string[] = [];
  for (let i = 0; i < names.length; i += 500) {
    const chunk = names.slice(i, i + 500);
    const rows = await sql<{ name: string }>(
      `SELECT DISTINCT name FROM scripts WHERE isScratch=0 AND name IN (${chunk.map(() => "?").join(",")}) AND ${DISPATCH_SQL}`,
      chunk,
    );
    dispatchers.push(...rows.map((r) => String(r.name)));
  }
  // Effect runs per day the run started, like their runs: a run at 23:59 whose
  // task lands after midnight still credits its own day, so tasks are read up
  // to 20 minutes past the window end.
  const effects = new Map<string, { other: number; api: number }>();
  if (dispatchers.length > 0) {
    const rows = await sql<{ d: string; nm: string; api: number; n: number }>(
      `SELECT ${bucketSql("r.startedAt", opts.bucket)} d, r.scriptName nm, (r.apiEndpointId IS NOT NULL) api, count(DISTINCT r.id) n
        FROM agent_tasks t INDEXED BY idx_agent_tasks_created
        JOIN script_runs r INDEXED BY idx_script_runs_scriptName_startedAt ON r.scriptName IN (${dispatchers.map(() => "?").join(",")})
          AND r.startedAt>=strftime('%Y-%m-%dT%H:%M:%fZ',t.createdAt,'-20 minutes') AND r.startedAt<=t.createdAt AND r.output LIKE '%'||t.id||'%'
          AND r.startedAt>=? AND r.startedAt<?
        WHERE t.createdAt>=? AND t.createdAt<strftime('%Y-%m-%dT%H:%M:%fZ',?,'+20 minutes') GROUP BY 1,2,3`,
      [...dispatchers, ...span, ...span],
    );
    for (const row of rows) {
      const key = `${row.nm}\u0000${row.d}`;
      const e = effects.get(key) ?? { other: 0, api: 0 };
      if (num(row.api)) e.api += num(row.n);
      else e.other += num(row.n);
      effects.set(key, e);
    }
  }

  const byName = new Map<string, ScriptDayFacts[]>();
  const push = (nm: string, f: ScriptDayFacts) => byName.set(nm, [...(byName.get(nm) ?? []), f]);
  for (const r of runs) {
    const nm = String(r.nm);
    const n = num(r.n);
    const perRun = nm === INLINE_SCRIPT_NAME ? INLINE_OPS : (ops.get(nm) ?? DEFAULT_OPS);
    const e = effects.get(`${nm}\u0000${r.d}`);
    push(nm, {
      day: String(r.d),
      runs: n,
      apiRuns: num(r.api),
      effectRuns: e?.other ?? 0,
      apiEffectRuns: e?.api ?? 0,
      opsSum: perRun * n,
      computeSecs: num(r.secs),
    });
  }
  return [...byName.entries()]
    .map(([scriptName, byDay]) => ({
      scriptName,
      byDay: byDay.sort((a, b) => a.day.localeCompare(b.day)),
    }))
    .sort((a, b) => a.scriptName.localeCompare(b.scriptName));
}
