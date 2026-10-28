import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  countScriptRuns,
  countSessions,
  createAgent,
  createTaskExtended,
  getAllTasks,
  getDb,
  getDbClient,
  getRecentCompletedCount,
  getStuckWorkflowRuns,
  getTaskByWorkflowRunStepId,
  getTasksCount,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { checkHeartbeatChecklist } from "../heartbeat/heartbeat";
import { getQueueStallSnapshot } from "../queue-stall-alarm";
import { AgentTaskStatusSchema, OPEN_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "../types";

const TEST_DB_PATH = "./test-query-audit-plans.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

interface Captured {
  sql: string;
  params: unknown[];
}

// Runs the real caller and returns the one statement it issued that matches
// `match`, so the plans below are of the SQL production sends, not a copy.
async function capturedSql(match: RegExp, run: () => Promise<unknown>): Promise<Captured> {
  const client = getDbClient();
  const seen: Captured[] = [];
  const query = client.query.bind(client);
  const get = client.get.bind(client);
  const record = (sql: string, params?: unknown[]) => {
    if (match.test(sql)) seen.push({ sql, params: params ?? [] });
  };
  const spies = [
    spyOn(client, "query").mockImplementation(((sql: string, params?: unknown[]) => {
      record(sql, params);
      return query(sql, params);
    }) as typeof client.query),
    spyOn(client, "get").mockImplementation(((sql: string, params?: unknown[]) => {
      record(sql, params);
      return get(sql, params);
    }) as typeof client.get),
  ];
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

function plan({ sql, params }: Captured, db: Database = getDb()): string {
  return db
    .query<{ detail: string }, any[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as any[]))
    .map((row) => row.detail)
    .join("\n");
}

// Plan of `captured` on a copy of the DB with `index` dropped, i.e. with
// migration 254 reverted.
function planWithoutIndex(captured: Captured, index: string): string {
  const copy = Database.deserialize(getDb().serialize());
  try {
    copy.run(`DROP INDEX ${index}`);
    return plan(captured, copy);
  } finally {
    copy.close();
  }
}

// Production has no sqlite_stat1, so the planner picks indexes without
// statistics. Each case runs the real caller, EXPLAINs the statement it
// issued, and checks the plan reaches its index. The regression control
// reverts that case's fix (the SQL shape or the migration 254 index) and
// checks the same assertion then fails, so a green case is not vacuous.
const CASES: Array<{
  name: string;
  match: RegExp;
  run: () => Promise<unknown>;
  uses: string[];
  revert: { sql: (sql: string) => string } | { dropIndex: string };
}> = [
  {
    name: "getTaskByWorkflowRunStepId",
    match: /workflowRunStepId/,
    run: () => getTaskByWorkflowRunStepId("step-1"),
    uses: [
      "SEARCH agent_tasks USING INDEX idx_agent_tasks_workflowRunStepId (workflowRunStepId=?)",
    ],
    revert: { dropIndex: "idx_agent_tasks_workflowRunStepId" },
  },
  {
    name: "getStuckWorkflowRuns",
    match: /workflow_run_steps/,
    run: () => getStuckWorkflowRuns(),
    uses: [
      "SEARCH wrs USING INDEX idx_wrs_status (status=?)",
      "SEARCH at USING INDEX idx_agent_tasks_workflowRunStepId (workflowRunStepId=?)",
    ],
    revert: { dropIndex: "idx_agent_tasks_workflowRunStepId" },
  },
  {
    name: "captureRoutingDecisionSnapshot",
    match: /FROM agents agent/,
    run: () => createTaskExtended("routing snapshot", {}),
    uses: ["MATERIALIZE open_task", "SEARCH agent_tasks USING INDEX idx_agent_tasks_status"],
    revert: { sql: (sql) => sql.replace("AS MATERIALIZED", "AS NOT MATERIALIZED") },
  },
  {
    name: "checkHeartbeatChecklist dedup",
    match: /heartbeat-checklist/,
    run: () => checkHeartbeatChecklist(),
    uses: ["SEARCH agent_tasks USING INDEX idx_agent_tasks_status"],
    revert: { sql: (sql) => sql.replace(/\+(agentId|taskType)/g, "$1") },
  },
  {
    name: "getRecentCompletedCount",
    match: /agent_tasks/,
    run: () => getRecentCompletedCount(),
    uses: ["COVERING INDEX idx_agent_tasks_status_finishedAt (status=? AND finishedAt>?)"],
    revert: { dropIndex: "idx_agent_tasks_status_finishedAt" },
  },
  {
    name: "countScriptRuns by scriptName",
    match: /script_runs/,
    run: () => countScriptRuns({ scriptName: "daily" }),
    uses: ["COVERING INDEX idx_script_runs_scriptName_startedAt (scriptName=?)"],
    revert: { dropIndex: "idx_script_runs_scriptName_startedAt" },
  },
  {
    name: "getQueueStallSnapshot pickups",
    match: /COUNT\(\*\) AS count\s+FROM agent_log/,
    run: () => getQueueStallSnapshot(),
    uses: ["SEARCH agent_log USING INDEX idx_agent_log_createdAt (createdAt>?)"],
    revert: { sql: (sql) => sql.replace("+eventType", "eventType") },
  },
  {
    name: "countSessions by source",
    match: /COUNT/,
    run: () => countSessions({ source: ["slack"] }),
    uses: ["COVERING INDEX idx_agent_tasks_parentTaskId_source (parentTaskId=? AND source=?)"],
    revert: { dropIndex: "idx_agent_tasks_parentTaskId_source" },
  },
  {
    // Few hits: the page reads the agent_tasks_fts candidates by rowid. The
    // control is the old `task LIKE '%q%'`, which scans every task body.
    name: "getAllTasks search",
    match: /WITH page AS/,
    run: async () => {
      await createTaskExtended("update the rulebook", {});
      return getAllTasks({ search: "rulebook" });
    },
    uses: ["CO-ROUTINE page\nSEARCH agent_tasks USING INTEGER PRIMARY KEY (rowid=?)"],
    revert: {
      sql: (sql) =>
        sql.replace(
          /agent_tasks\.rowid IN \([\d, ]+\)/,
          "(task LIKE '%rulebook%' OR title LIKE '%rulebook%' OR id LIKE '%rulebook%')",
        ),
    },
  },
];

function missing(detail: string, uses: string[]): string[] {
  return uses.filter((step) => !detail.includes(step));
}

describe("query audit plans without sqlite_stat1", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    // checkHeartbeatChecklist reaches its dedup only for a lead with a
    // checklist, and stops there when an open checklist task exists.
    const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
    await updateAgentProfile(lead.id, { heartbeatMd: "# Checklist\n\n- Check stuck tasks\n" });
    await createTaskExtended("open checklist", {
      agentId: lead.id,
      taskType: "heartbeat-checklist",
    });
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

  for (const { name, match, run, uses, revert } of CASES) {
    test(`${name} uses its index, and loses it when the fix is reverted`, async () => {
      const captured = await capturedSql(match, run);
      const detail = plan(captured);
      expect(missing(detail, uses)).toEqual([]);
      expect(detail).not.toContain("SCAN agent_tasks");

      const reverted =
        "dropIndex" in revert
          ? planWithoutIndex(captured, revert.dropIndex)
          : plan({ ...captured, sql: revert.sql(captured.sql) });
      expect(missing(reverted, uses)).not.toEqual([]);
    });
  }

  test("task search with many hits pages by lastUpdatedAt and counts from the index", async () => {
    await getDbClient().transaction(async (tx) => {
      for (let i = 0; i < 501; i++) {
        await tx.run(
          `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt)
           VALUES (?, ?, 'completed', 'api', ?, ?)`,
          [`landing-${i}`, `landing page ${i}`, "2026-10-01T00:00:00.000Z", `2026-10-01T${i}`],
        );
      }
    });

    // The page walks its ORDER BY index and stops at LIMIT, testing each row
    // against the FTS hits. Without the `+`, the planner drives from the
    // hits and sorts them all, reading every matching task body.
    const page = await capturedSql(/WITH page AS/, () => getAllTasks({ search: "landing" }));
    const pageUses = [
      "CO-ROUTINE page\nSCAN agent_tasks USING INDEX idx_agent_tasks_last_updated",
      "SCAN agent_tasks_fts VIRTUAL TABLE",
    ];
    expect(page.sql).not.toContain("task LIKE");
    expect(missing(plan(page), pageUses)).toEqual([]);
    const pageReverted = plan({
      ...page,
      sql: page.sql.replace("+agent_tasks.rowid", "agent_tasks.rowid"),
    });
    expect(missing(pageReverted, pageUses)).not.toEqual([]);

    // A count has no LIMIT to stop at, so it drives from the hits.
    const count = await capturedSql(/COUNT/, () => getTasksCount({ search: "landing" }));
    const countUses = [
      "SCAN agent_tasks_fts VIRTUAL TABLE",
      "SEARCH agent_tasks USING INTEGER PRIMARY KEY (rowid=?)",
    ];
    expect(count.sql).not.toContain("task LIKE");
    expect(missing(plan(count), countUses)).toEqual([]);
    expect(plan(count)).not.toContain("SCAN agent_tasks USING");
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
