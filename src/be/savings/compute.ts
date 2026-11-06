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
  childTaskUsd: 0,
  childTaskMs: 0,
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

/** UTC day (`YYYY-MM-DD`) of an ISO `startedAt`. */
const DAY_SQL = "substr(r.startedAt,1,10)";

/** Every run's facts, grouped by the UTC day it started; the window facts are their sum. */
export async function computeWorkflowWindow(
  workflow: { id: string; definition: unknown },
  window: { start: string; end: string },
  sql: SavingsSql = defaultSql,
  opts: { maxRuns?: number } = {},
): Promise<WorkflowWindow> {
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

/**
 * Facts of every script with runs in the window (or of one script), grouped by
 * the UTC day the runs started. Ported from v7 `scriptJobs`: runs are keyed by
 * `scriptName` (runs without one by INLINE_SCRIPT_NAME), ops are the `await`
 * count of the catalog source (the global row wins), and a run had an effect
 * when its output names an agent task created while it ran (up to 20 minutes
 * after it started), counted on the day the run started. v7 folds names beyond its first 900 into a tail row; here
 * every name keeps its own row and ops.
 */
export async function computeScriptWindow(
  window: { start: string; end: string },
  sql: SavingsSql = defaultSql,
  opts: { scriptName?: string } = {},
): Promise<ScriptWindowFacts[]> {
  const span = [window.start, window.end];
  const where = opts.scriptName === undefined ? "" : "AND coalesce(scriptName, ?)=?";
  const params =
    opts.scriptName === undefined ? span : [...span, INLINE_SCRIPT_NAME, opts.scriptName];
  const runs = await sql<{ d: string; nm: string; n: number; api: number; secs: number | null }>(
    `SELECT substr(startedAt,1,10) d, coalesce(scriptName,'${INLINE_SCRIPT_NAME}') nm, count(*) n, sum(apiEndpointId IS NOT NULL) api,
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
  // A task stamped with the run that created it (its run token) links
  // exactly; the output probe covers unstamped tasks of dispatching scripts.
  const tasksTo = "strftime('%Y-%m-%dT%H:%M:%fZ',?,'+20 minutes')";
  const probe =
    dispatchers.length > 0
      ? `UNION SELECT substr(r.startedAt,1,10) d, r.scriptName nm, (r.apiEndpointId IS NOT NULL) api, r.id
        FROM agent_tasks t INDEXED BY idx_agent_tasks_created
        JOIN script_runs r INDEXED BY idx_script_runs_scriptName_startedAt ON r.scriptName IN (${dispatchers.map(() => "?").join(",")})
          AND r.startedAt>=strftime('%Y-%m-%dT%H:%M:%fZ',t.createdAt,'-20 minutes') AND r.startedAt<=t.createdAt AND r.output LIKE '%'||t.id||'%'
          AND r.startedAt>=? AND r.startedAt<?
        WHERE t.createdAt>=? AND t.createdAt<${tasksTo} AND t.sourceScriptRunId IS NULL`
      : "";
  const rows = await sql<{ d: string; nm: string; api: number; n: number }>(
    `SELECT d, nm, api, count(DISTINCT id) n FROM (
       SELECT substr(r.startedAt,1,10) d, coalesce(r.scriptName,'${INLINE_SCRIPT_NAME}') nm, (r.apiEndpointId IS NOT NULL) api, r.id
       FROM agent_tasks t INDEXED BY idx_agent_tasks_sourceScriptRun_created JOIN script_runs r ON r.id=t.sourceScriptRunId
       WHERE t.sourceScriptRunId IS NOT NULL AND t.createdAt>=? AND t.createdAt<${tasksTo}
         AND r.startedAt>=? AND r.startedAt<? ${opts.scriptName === undefined ? "" : "AND coalesce(r.scriptName, ?)=?"}
       ${probe}
     ) GROUP BY 1,2,3`,
    [
      ...span,
      ...span,
      ...(opts.scriptName === undefined ? [] : [INLINE_SCRIPT_NAME, opts.scriptName]),
      ...(dispatchers.length > 0 ? [...dispatchers, ...span, ...span] : []),
    ],
  );
  for (const row of rows) {
    const key = `${row.nm}\u0000${row.d}`;
    const e = effects.get(key) ?? { other: 0, api: 0 };
    if (num(row.api)) e.api += num(row.n);
    else e.other += num(row.n);
    effects.set(key, e);
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

/** A workflow's link to something its runs caused, for one UTC day. */
export type SavingsLink = {
  parentJobId: string;
  childKind: "workflow" | "script" | "task";
  /** Workflow id, script name, or "" for tasks. */
  childJobId: string;
  /**
   * `sub-workflow`: child run of a sub-workflow node (parentStepId).
   * `step-workflow`, `step-script`, `step-task`: a run, nested script run or
   * task a swarm-script step made. `descendant-task`: a task below the
   * agent-task nodes' tasks (parentTaskId).
   */
  linkKind: "sub-workflow" | "step-workflow" | "step-script" | "step-task" | "descendant-task";
  n: number;
  /** Session cost of linked tasks (with their descendants for `step-task`); 0 for runs. */
  actualUsd: number;
  /** The part of `actualUsd` the parent's own row keeps on both sides. */
  keptUsd: number;
};

export type WorkflowLinksDay = {
  links: SavingsLink[];
  /** Per parent workflow: spend of the tasks it caused without owning them (`WorkflowFacts.childTaskUsd`). */
  childTasks: Map<string, { usd: number; ms: number }>;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A run or task a step made starts while the step runs, or within 5 s of its end. */
const STEP_GRACE_MS = 5_000;
/** Deepest task chain followed below a root task (the deepest seen is 17). */
const MAX_TASK_DEPTH = 20;

async function inChunks<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(await fn(ids.slice(i, i + 500))));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * What every workflow's runs caused on one UTC day (by the child's start),
 * for the "with components" view and the kept spend of unowned tasks.
 *
 * - Sub-workflow children: `parentStepId`, exact.
 * - Runs, tasks and nested script runs a swarm-script step made: the step id
 *   its run token stamped (`sourceStepId`). Unstamped runs and tasks (made
 *   before the stamp existed, or by a run with no token) fall back to an id in
 *   the step's output plus a start inside the step; stamped rows never take
 *   that path. Nested script runs are linked only when stamped: matching them
 *   by time is too noisy (agents call the same scripts by hand).
 * - Task spend: the tasks the steps made, and the descendants (`parentTaskId`,
 *   stopping at a task with its own workflow run) of those and of the
 *   agent-task nodes' tasks.
 */
export async function computeWorkflowLinksDay(
  window: { start: string; end: string },
  workflows: { id: string; definition: unknown }[],
  sql: SavingsSql = defaultSql,
): Promise<WorkflowLinksDay> {
  const span = [window.start, window.end];
  const links = new Map<string, SavingsLink>();
  const add = (l: Omit<SavingsLink, "actualUsd" | "keptUsd"> & { usd?: number }) => {
    const key = [l.parentJobId, l.childKind, l.childJobId, l.linkKind].join("\u0000");
    const prev = links.get(key);
    const usd = l.usd ?? 0;
    links.set(key, {
      parentJobId: l.parentJobId,
      childKind: l.childKind,
      childJobId: l.childJobId,
      linkKind: l.linkKind,
      n: (prev?.n ?? 0) + l.n,
      actualUsd: (prev?.actualUsd ?? 0) + usd,
      keptUsd: (prev?.keptUsd ?? 0) + (l.childKind === "task" ? usd : 0),
    });
  };

  const subRuns = await sql<{ pid: string; cid: string; n: number }>(
    `SELECT p.workflowId pid, c.workflowId cid, count(*) n FROM workflow_runs c INDEXED BY idx_workflow_runs_parentStep_attempt
      JOIN workflow_run_steps s ON s.id=c.parentStepId JOIN workflow_runs p ON p.id=s.runId
      WHERE c.parentStepId IS NOT NULL AND c.startedAt>=? AND c.startedAt<? GROUP BY 1,2`,
    span,
  );
  for (const r of subRuns) {
    add({
      parentJobId: r.pid,
      childKind: "workflow",
      childJobId: r.cid,
      linkKind: "sub-workflow",
      n: num(r.n),
    });
  }
  const stampedRuns = await sql<{ pid: string; cid: string; n: number }>(
    `SELECT p.workflowId pid, c.workflowId cid, count(*) n FROM workflow_runs c INDEXED BY idx_workflow_runs_sourceStep_started
      JOIN workflow_run_steps s ON s.id=c.sourceStepId JOIN workflow_runs p ON p.id=s.runId
      WHERE c.sourceStepId IS NOT NULL AND c.startedAt>=? AND c.startedAt<? GROUP BY 1,2`,
    span,
  );
  for (const r of stampedRuns) {
    add({
      parentJobId: r.pid,
      childKind: "workflow",
      childJobId: r.cid,
      linkKind: "step-workflow",
      n: num(r.n),
    });
  }
  const stampedScripts = await sql<{ pid: string; nm: string; n: number }>(
    `SELECT p.workflowId pid, coalesce(r.scriptName,'${INLINE_SCRIPT_NAME}') nm, count(*) n FROM script_runs r INDEXED BY idx_script_runs_sourceStep_started
      JOIN workflow_run_steps s ON s.id=r.sourceStepId JOIN workflow_runs p ON p.id=s.runId
      WHERE r.sourceStepId IS NOT NULL AND r.startedAt>=? AND r.startedAt<? GROUP BY 1,2`,
    span,
  );
  for (const r of stampedScripts) {
    add({
      parentJobId: r.pid,
      childKind: "script",
      childJobId: String(r.nm),
      linkKind: "step-script",
      n: num(r.n),
    });
  }

  // Tasks the steps made, per parent workflow.
  const stepTasks = new Map<string, string>();
  for (const r of await sql<{ pid: string; id: string }>(
    `SELECT p.workflowId pid, t.id FROM agent_tasks t INDEXED BY idx_agent_tasks_sourceStep_created
      JOIN workflow_run_steps s ON s.id=t.sourceStepId JOIN workflow_runs p ON p.id=s.runId
      WHERE t.sourceStepId IS NOT NULL AND t.createdAt>=? AND t.createdAt<?`,
    span,
  )) {
    stepTasks.set(String(r.id), String(r.pid));
  }

  await linkFromStepOutputs(window, workflows, sql, (pid, kind, id, childWorkflowId) => {
    if (kind === "task") {
      if (!stepTasks.has(id)) stepTasks.set(id, pid);
    } else {
      add({
        parentJobId: pid,
        childKind: "workflow",
        childJobId: childWorkflowId as string,
        linkKind: "step-workflow",
        n: 1,
      });
    }
  });

  // Agent-task nodes' tasks: their own cost is in the row already; only their descendants add.
  const nodeTasks = new Map<string, string>();
  for (const r of await sql<{ pid: string; id: string }>(
    `SELECT p.workflowId pid, t.id FROM agent_tasks t INDEXED BY idx_agent_tasks_created JOIN workflow_runs p ON p.id=t.workflowRunId
      WHERE t.createdAt>=? AND t.createdAt<? AND t.workflowRunId IS NOT NULL`,
    span,
  )) {
    nodeTasks.set(String(r.id), String(r.pid));
  }

  const childTasks = new Map<string, { usd: number; ms: number }>();
  const keep = (pid: string, usd: number, ms: number) => {
    const c = childTasks.get(pid) ?? { usd: 0, ms: 0 };
    childTasks.set(pid, { usd: c.usd + usd, ms: c.ms + ms });
  };
  // Each task counts under exactly one root: the walk stops at any other root
  // of the day and at any task a step or a node owns (on any day), so all
  // roots go in as one set.
  const roots = [...new Set([...stepTasks.keys(), ...nodeTasks.keys()])];
  const trees =
    roots.length === 0
      ? []
      : await sql<{
          root: string;
          below: number;
          n: number;
          usd: number | null;
          ms: number | null;
        }>(
          `WITH RECURSIVE r(id) AS (SELECT value FROM json_each(?)),
           d(root, id, depth) AS (
             SELECT id, id, 0 FROM r
             UNION ALL SELECT d.root, k.id, d.depth+1 FROM d JOIN agent_tasks k INDEXED BY idx_agent_tasks_parentTaskId ON k.parentTaskId=d.id
               WHERE k.workflowRunId IS NULL AND k.sourceStepId IS NULL AND k.id NOT IN (SELECT id FROM r)
                 AND d.depth<${MAX_TASK_DEPTH})
           SELECT root, depth>0 below, count(*) n,
             sum((SELECT sum(totalCostUsd) FROM session_costs c WHERE c.taskId=d.id)) usd,
             sum((SELECT sum(durationMs) FROM session_costs c WHERE c.taskId=d.id)) ms
           FROM d GROUP BY 1,2`,
          [JSON.stringify(roots)],
        );
  for (const t of trees) {
    const root = String(t.root);
    const below = num(t.below) === 1;
    const fromStep = stepTasks.get(root);
    const pid = fromStep ?? nodeTasks.get(root);
    if (!pid) continue;
    // A node task's own cost is the row's agentUsd; a step task counts whole.
    if (!fromStep && !below) continue;
    const usd = num(t.usd);
    keep(pid, usd, num(t.ms));
    if (fromStep) {
      // n counts the tasks the step made; their descendants add only spend.
      add({
        parentJobId: pid,
        childKind: "task",
        childJobId: "",
        linkKind: "step-task",
        n: below ? 0 : num(t.n),
        usd,
      });
    } else {
      add({
        parentJobId: pid,
        childKind: "task",
        childJobId: "",
        linkKind: "descendant-task",
        n: num(t.n),
        usd,
      });
    }
  }
  return { links: [...links.values()], childTasks };
}

/**
 * The unstamped fallback: runs and tasks whose id a dispatching step's output
 * names and that started while the step ran. Only steps of nodes whose script
 * can dispatch (`DISPATCH_SQL`) are read.
 */
async function linkFromStepOutputs(
  window: { start: string; end: string },
  workflows: { id: string; definition: unknown }[],
  sql: SavingsSql,
  onLink: (
    parentWorkflowId: string,
    kind: "workflow" | "task",
    id: string,
    childWorkflowId?: string,
  ) => void,
): Promise<void> {
  const nodesByWorkflow = new Map<string, { nodeId: string; scriptName: string }[]>();
  for (const w of workflows) {
    const nodes =
      (
        (w.definition ?? {}) as {
          nodes?: { id: string; type: string; config?: Record<string, unknown> }[];
        }
      ).nodes ?? [];
    const scripted = nodes
      .filter((n) => n.type === "swarm-script" && typeof n.config?.scriptName === "string")
      .map((n) => ({ nodeId: n.id, scriptName: n.config?.scriptName as string }));
    if (scripted.length > 0) nodesByWorkflow.set(w.id, scripted);
  }
  const names = [...new Set([...nodesByWorkflow.values()].flat().map((n) => n.scriptName))];
  if (names.length === 0) return;
  const dispatchers = new Set(
    (
      await inChunks(names, (chunk) =>
        sql<{ name: string }>(
          `SELECT DISTINCT name FROM scripts WHERE isScratch=0 AND name IN (${marks(chunk.length)}) AND ${DISPATCH_SQL}`,
          chunk,
        ),
      )
    ).map((r) => String(r.name)),
  );
  for (const [workflowId, nodes] of nodesByWorkflow) {
    const nodeIds = nodes.filter((n) => dispatchers.has(n.scriptName)).map((n) => n.nodeId);
    if (nodeIds.length === 0) continue;
    const steps = await sql<{ id: string; sa: string; fa: string; output: string | null }>(
      `SELECT s.id, s.startedAt sa, coalesce(s.finishedAt,s.startedAt) fa, s.output FROM workflow_runs p INDEXED BY idx_workflow_runs_workflow_started
        JOIN workflow_run_steps s ON s.runId=p.id
        WHERE p.workflowId=? AND p.startedAt>=? AND p.startedAt<? AND s.nodeType='swarm-script' AND s.output IS NOT NULL
          AND (s.nodeId IN (${marks(nodeIds.length)}) OR ${nodeIds.map(() => "s.nodeId LIKE ?").join(" OR ")})`,
      [workflowId, window.start, window.end, ...nodeIds, ...nodeIds.map((id) => `${id}#%`)],
    );
    const named = new Map<string, { sa: number; fa: number }[]>();
    for (const s of steps) {
      const range = { sa: Date.parse(s.sa), fa: Date.parse(s.fa) + STEP_GRACE_MS };
      for (const id of new Set(String(s.output).toLowerCase().match(UUID_RE) ?? [])) {
        if (id === String(s.id)) continue;
        named.set(id, [...(named.get(id) ?? []), range]);
      }
    }
    if (named.size === 0) continue;
    const inStep = (id: string, at: string) =>
      (named.get(id) ?? []).some((r) => Date.parse(at) >= r.sa && Date.parse(at) <= r.fa);
    const ids = [...named.keys()];
    const runs = await inChunks(ids, (chunk) =>
      sql<{ id: string; wid: string; at: string }>(
        `SELECT id, workflowId wid, startedAt at FROM workflow_runs WHERE id IN (${marks(chunk.length)})
          AND parentStepId IS NULL AND sourceStepId IS NULL AND triggerType IN ('api','manual')`,
        chunk,
      ),
    );
    for (const r of runs) {
      if (inStep(String(r.id), String(r.at)))
        onLink(workflowId, "workflow", String(r.id), String(r.wid));
    }
    const tasks = await inChunks(ids, (chunk) =>
      sql<{ id: string; at: string }>(
        `SELECT id, createdAt at FROM agent_tasks WHERE id IN (${marks(chunk.length)})
          AND workflowRunId IS NULL AND sourceStepId IS NULL`,
        chunk,
      ),
    );
    for (const t of tasks) {
      if (inStep(String(t.id), String(t.at))) onLink(workflowId, "task", String(t.id));
    }
  }
}
