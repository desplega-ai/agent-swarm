/**
 * Live facts for one workflow over a window, read from workflow_runs, steps,
 * agent tasks and session costs. The SQL is ported from the
 * `automation-savings-estimate` script (v7); pricing lives in `model.ts`.
 */
import { getDbClient } from "../db";
import type { DbParam } from "../db-client";
import { JEV_PER_M, nodeOpsOf, scriptOpsFromAwaitCount, type WorkflowFacts } from "./model";

/** Runs a read query. The default is the API's own DB client. */
export type SavingsSql = <T>(sql: string, params: DbParam[]) => Promise<T[]>;

const defaultSql: SavingsSql = (sql, params) => getDbClient().query(sql, params);

/**
 * Above this many runs in the window the live path refuses: the router
 * (~360k runs in 30 days) takes 3 to 7 s for its effect query alone.
 * shortcut: a fixed cutoff instead of the plan's router rule; the daily
 * rollup (next PR) computes high-volume workflows one day at a time.
 */
export const LIVE_MAX_RUNS = 10_000;

export type WorkflowWindow =
  | { status: "ok"; facts: WorkflowFacts }
  | { status: "too-many-runs"; runs: number };

// A run "caused a downstream effect" when it created an agent task or started a child workflow run.
const EFFECT_SQL =
  "(EXISTS(SELECT 1 FROM agent_tasks k WHERE k.workflowRunId=r.id) OR EXISTS(SELECT 1 FROM workflow_run_steps s2 JOIN workflow_runs c ON c.parentStepId=s2.id WHERE s2.runId=r.id))";
const AWAITS_SQL = "(length(source)-length(replace(source,'await','')))/5";

const num = (v: unknown): number => Number(v) || 0;

const emptyFacts = (runs: number): WorkflowFacts => ({
  runs,
  countedRuns: 0,
  schedRuns: 0,
  schedEffectRuns: 0,
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
  const rows = await sql<{ name: string; aw: number }>(
    `SELECT name, ${AWAITS_SQL} aw FROM scripts WHERE isScratch=0 AND name IN (${unique.map(() => "?").join(",")}) ORDER BY scope='global'`,
    unique,
  );
  for (const row of rows) ops.set(row.name, scriptOpsFromAwaitCount(row.aw));
  return ops;
}

export async function computeWorkflowWindow(
  workflow: { id: string; definition: unknown },
  window: { start: string; end: string },
  sql: SavingsSql = defaultSql,
): Promise<WorkflowWindow> {
  const span = [workflow.id, window.start, window.end];
  // Index-only count first, so a high-volume workflow never reaches the step scans.
  const total = num(
    (
      await sql<{ n: number }>(
        "SELECT count(*) n FROM workflow_runs WHERE workflowId=? AND startedAt>=? AND startedAt<?",
        span,
      )
    )[0]?.n,
  );
  if (total === 0) return { status: "ok", facts: emptyFacts(0) };
  if (total > LIVE_MAX_RUNS) return { status: "too-many-runs", runs: total };

  const byTrigger = await sql<{ tt: string; st: string; n: number }>(
    "SELECT triggerType tt, status st, count(*) n FROM workflow_runs WHERE workflowId=? AND startedAt>=? AND startedAt<? GROUP BY 1,2",
    span,
  );
  const runs = byTrigger.reduce((s, r) => s + num(r.n), 0);
  const counted = byTrigger.filter((r) => r.st !== "skipped" && r.st !== "cancelled");
  const countedRuns = counted.reduce((s, r) => s + num(r.n), 0);
  const schedRuns = counted.filter((r) => r.tt === "schedule").reduce((s, r) => s + num(r.n), 0);
  const schedEffectRuns =
    schedRuns > 0
      ? num(
          (
            await sql<{ n: number }>(
              `SELECT count(*) n FROM workflow_runs r WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? AND r.triggerType='schedule' AND r.status NOT IN ('skipped','cancelled') AND ${EFFECT_SQL}`,
              span,
            )
          )[0]?.n,
        )
      : 0;

  const definition = (workflow.definition ?? {}) as {
    nodes?: { id: string; type: string; config?: Record<string, unknown> }[];
  };
  const scriptNames = (definition.nodes ?? [])
    .filter((n) => n.type === "swarm-script")
    .map((n) => n.config?.scriptName)
    .filter((n): n is string => typeof n === "string");
  const nodeOps = nodeOpsOf(definition, await scriptOps(scriptNames, sql));

  const steps = await sql<{
    nid: string;
    n: number;
    secs: number | null;
    itok: number | null;
    rchars: number | null;
    jev: number | null;
    clairic: number | null;
  }>(
    `SELECT s.nodeId nid, count(*) n, sum(CASE WHEN s.nodeType NOT IN ('agent-task','wait','human-in-the-loop','foreach','sub-workflow') THEN (julianday(coalesce(s.finishedAt,s.startedAt))-julianday(s.startedAt))*86400 ELSE 0 END) secs,
      sum(CASE WHEN s.nodeType LIKE 'system-one%' THEN json_extract(s.output,'$.usage.input_tokens') END) itok,
      sum(CASE WHEN s.nodeType='raw-llm' THEN length(json_extract(s.output,'$.result')) END) rchars,
      sum(CASE WHEN s.nodeId='report' THEN json_extract(s.output,'$.result.summary.jevCostUsd') END) jev,
      sum(CASE WHEN s.nodeId='report' THEN json_extract(s.output,'$.result.cost.clairicUsd') END) clairic
      FROM workflow_runs r JOIN workflow_run_steps s ON s.runId=r.id WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<? GROUP BY 1`,
    span,
  );
  const agent =
    (
      await sql<{ tasks: number; usd: number | null; ms: number | null; fup: number | null }>(
        `SELECT count(DISTINCT t.id) tasks, sum(c.u) usd, sum(c.ms) ms,
      (SELECT sum(c2.totalCostUsd) FROM workflow_runs r2 JOIN agent_tasks t2 ON t2.workflowRunId=r2.id JOIN agent_tasks k ON k.parentTaskId=t2.id AND (k.task LIKE 'Worker task completed%' OR k.task LIKE 'Worker task failed%') JOIN session_costs c2 ON c2.taskId=k.id WHERE r2.workflowId=? AND r2.startedAt>=? AND r2.startedAt<?) fup
      FROM workflow_runs r JOIN agent_tasks t ON t.workflowRunId=r.id LEFT JOIN (SELECT taskId, sum(totalCostUsd) u, sum(durationMs) ms FROM session_costs GROUP BY taskId) c ON c.taskId=t.id
      WHERE r.workflowId=? AND r.startedAt>=? AND r.startedAt<?`,
        [...span, ...span],
      )
    )[0] ?? null;

  return {
    status: "ok",
    facts: {
      runs,
      countedRuns,
      schedRuns,
      schedEffectRuns,
      // foreach iterations store `<nodeId>#<i>`.
      opsSum: steps.reduce(
        (s, x) => s + (nodeOps.get(String(x.nid).split("#")[0] ?? "") ?? 0) * num(x.n),
        0,
      ),
      agentTasks: num(agent?.tasks),
      agentUsd: num(agent?.usd),
      agentMs: num(agent?.ms),
      followupUsd: num(agent?.fup),
      recordedLlmUsd: steps.reduce((s, x) => s + num(x.jev) + num(x.clairic), 0),
      estimatedLlmUsd: steps.reduce(
        (s, x) => s + (num(x.itok) / 1e6) * JEV_PER_M + (num(x.rchars) * (1.2 / 4 + 0.3)) / 1e6,
        0,
      ),
      computeSecs: steps.reduce((s, x) => s + num(x.secs), 0),
    },
  };
}
