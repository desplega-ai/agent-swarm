import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, getStuckWorkflowRuns, initDb } from "../be/db";
import { sessionCountQuery } from "../be/db/session-tree";
import { AgentTaskStatusSchema, OPEN_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "../types";

const TEST_DB_PATH = "./test-query-audit-plans.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

const open = OPEN_TASK_STATUSES.map(() => "?").join(", ");

// Production has no sqlite_stat1, so the planner picks indexes without
// statistics. Each query must reach its index on plan shape alone. The SQL
// mirrors the call site named in each case.
const PLANS: Array<{ name: string; sql: string; params: unknown[]; uses: string[] }> = [
  {
    name: "getTaskByWorkflowRunStepId",
    sql: "SELECT * FROM agent_tasks WHERE workflowRunStepId = ? LIMIT 1",
    params: ["step-1"],
    uses: [
      "SEARCH agent_tasks USING INDEX idx_agent_tasks_workflowRunStepId (workflowRunStepId=?)",
    ],
  },
  {
    name: "getStuckWorkflowRuns",
    sql: `SELECT wr.id, wrs.id, at.output
      FROM workflow_run_steps wrs
      CROSS JOIN workflow_runs wr ON wr.id = wrs.runId
      CROSS JOIN agent_tasks at ON at.workflowRunStepId = wrs.id
      WHERE wrs.status = 'waiting' AND wr.status = 'waiting'
        AND at.status IN ('completed', 'failed', 'cancelled')
      ORDER BY at.createdAt ASC, at.rowid ASC`,
    params: [],
    uses: [
      "SEARCH wrs USING INDEX idx_wrs_status (status=?)",
      "SEARCH at USING INDEX idx_agent_tasks_workflowRunStepId (workflowRunStepId=?)",
    ],
  },
  {
    name: "captureRoutingDecisionSnapshot",
    sql: `WITH open_task AS MATERIALIZED (
        SELECT id, agentId, offeredTo, status FROM agent_tasks WHERE status IN (${open})
      )
      SELECT agent.id, COUNT(task.id) FROM agents agent
      LEFT JOIN open_task task ON task.agentId = agent.id OR task.offeredTo = agent.id
      WHERE agent.isLead = 0 GROUP BY agent.id, agent.status ORDER BY agent.id`,
    params: [...OPEN_TASK_STATUSES],
    uses: ["MATERIALIZE open_task", "SEARCH agent_tasks USING INDEX idx_agent_tasks_status"],
  },
  {
    name: "checkHeartbeatChecklist dedup",
    sql: `SELECT id FROM agent_tasks
      WHERE status IN (${open}) AND +agentId = ? AND +taskType = 'heartbeat-checklist' LIMIT 1`,
    params: [...OPEN_TASK_STATUSES, "lead"],
    uses: ["SEARCH agent_tasks USING INDEX idx_agent_tasks_status"],
  },
  {
    name: "getRecentCompletedCount",
    sql: "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'completed' AND finishedAt > ?",
    params: ["2026-10-27T00:00:00.000Z"],
    uses: ["COVERING INDEX idx_agent_tasks_status_finishedAt (status=? AND finishedAt>?)"],
  },
  {
    name: "countScriptRuns by scriptName",
    sql: "SELECT COUNT(*) AS count FROM script_runs WHERE scriptName = ?",
    params: ["daily"],
    uses: ["COVERING INDEX idx_script_runs_scriptName_startedAt (scriptName=?)"],
  },
  {
    name: "getQueueStallSnapshot pickups",
    sql: `SELECT COUNT(*) AS count FROM agent_log
      WHERE +eventType IN ('task_status_change', 'task_claimed')
        AND oldValue IN ('pending', 'unassigned') AND newValue = 'in_progress'
        AND createdAt >= ?`,
    params: ["2026-10-27T00:00:00.000Z"],
    uses: ["SEARCH agent_log USING INDEX idx_agent_log_createdAt (createdAt>?)"],
  },
];

describe("query audit plans without sqlite_stat1", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  test("the test DB has no planner statistics, like production", async () => {
    const stat = await getDbClient().get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'",
    );
    expect(stat).toBeNull();
  });

  for (const { name, sql, params, uses } of PLANS) {
    test(`${name} uses its index`, async () => {
      const plan = await getDbClient().query<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${sql}`,
        params,
      );
      const detail = plan.map((row) => row.detail).join("\n");
      for (const step of uses) expect(detail).toContain(step);
      expect(detail).not.toContain("SCAN agent_tasks");
    });
  }

  test("session root count by source is covered by (parentTaskId, source)", async () => {
    const query = sessionCountQuery({ source: ["slack"] });
    const plan = await getDbClient().query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${query.sql}`,
      query.params,
    );
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "COVERING INDEX idx_agent_tasks_parentTaskId_source (parentTaskId=? AND source=?)",
    );
  });

  test("getStuckWorkflowRuns returns only finished tasks of waiting steps in waiting runs", async () => {
    const client = getDbClient();
    await client.run("PRAGMA foreign_keys = OFF");
    const now = "2026-10-27T00:00:00.000Z";
    const cases = [
      { id: "stuck", runStatus: "waiting", stepStatus: "waiting", taskStatus: "completed" },
      {
        id: "running-task",
        runStatus: "waiting",
        stepStatus: "waiting",
        taskStatus: "in_progress",
      },
      { id: "done-step", runStatus: "waiting", stepStatus: "completed", taskStatus: "failed" },
      { id: "running-run", runStatus: "running", stepStatus: "waiting", taskStatus: "cancelled" },
    ];
    for (const c of cases) {
      await client.run(
        "INSERT INTO workflow_runs (id, workflowId, status, startedAt) VALUES (?, 'wf', ?, ?)",
        [`run-${c.id}`, c.runStatus, now],
      );
      await client.run(
        `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt)
         VALUES (?, ?, 'node', 'agent-task', ?, ?)`,
        [`step-${c.id}`, `run-${c.id}`, c.stepStatus, now],
      );
      await client.run(
        `INSERT INTO agent_tasks (id, task, status, output, workflowRunStepId, createdAt, lastUpdatedAt)
         VALUES (?, 'task', ?, 'out', ?, ?, ?)`,
        [`task-${c.id}`, c.taskStatus, `step-${c.id}`, now, now],
      );
    }

    expect(await getStuckWorkflowRuns()).toEqual([
      {
        runId: "run-stuck",
        stepId: "step-stuck",
        nodeId: "node",
        taskId: "task-stuck",
        taskStatus: "completed",
        taskOutput: "out",
        workflowId: "wf",
      },
    ]);
  });
});

describe("OPEN_TASK_STATUSES", () => {
  test("open and terminal statuses partition every task status", () => {
    const all = [...AgentTaskStatusSchema.options].sort();
    expect([...OPEN_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort()).toEqual(all);
    const terminal = new Set<string>(TERMINAL_TASK_STATUSES);
    expect(OPEN_TASK_STATUSES.filter((status) => terminal.has(status))).toEqual([]);
  });
});
