import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createTaskExtended, createWorkflow, getDbClient, initDb } from "../be/db";
import {
  drainHumanFreeReclassifyQueue,
  HUMAN_FREE_RECLASSIFY_BATCH,
  pendingHumanFreeReclassifications,
} from "../be/db/tasks/human-free";
import * as retentionDb from "../be/db/workflow-run-retention";
import {
  deleteWorkflowRunRetentionBatch,
  WORKFLOW_RETENTION_CANDIDATES_SQL,
} from "../be/db/workflow-run-retention";
import { getChildWorkflowRunId, getRunLineageBlock } from "../be/db/workflow-runs";
import { DbTransactionDeadlineError } from "../be/db-client";
import {
  DB_RETENTION_TABLES,
  getDbRetentionStats,
  resetDbRetentionForTests,
  runDbRetentionTick,
  sweepStatements,
} from "../be/db-retention";
import { expectFlagsMatchLegacy, legacyHumanFreeIds, storedFlags } from "./human-free-oracle";

const DB_PATH = "./test-workflow-runs-retention.sqlite";
const NOW = new Date("2026-11-06T12:00:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2026-11-06T11:00:00.000Z";
const CUTOFF = "2026-11-05 12:00:00";
const DAYS_KEY = "WORKFLOW_RUNS_RETENTION_DAYS";
const POLICY = DB_RETENTION_TABLES.find((table) => table.table === "workflow_runs")!;
let workflowId: string;
// The restart regression must reopen the persisted queue, not a fresh copy of
// the preload's in-memory migration template.
const testGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let migrationTemplate: Uint8Array | undefined;

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(DB_PATH + suffix).catch(() => {});
}

async function run(
  id: string,
  status = "completed",
  finishedAt: string | null = OLD,
  options: { parentStepId?: string; attempt?: number; hash?: string } = {},
) {
  await getDbClient().run(
    `INSERT INTO workflow_runs
       (id, workflowId, status, startedAt, finishedAt, parentStepId, parentStepAttempt, definitionHash, triggerType)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'schedule')`,
    [
      id,
      workflowId,
      status,
      OLD,
      finishedAt,
      options.parentStepId ?? null,
      options.attempt ?? 0,
      options.hash ?? null,
    ],
  );
}

async function step(id: string, runId: string) {
  await getDbClient().run(
    "INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status) VALUES (?, ?, ?, 'sub-workflow', 'completed')",
    [id, runId, id],
  );
}

async function ids(table = "workflow_runs") {
  return (await getDbClient().query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).map(
    (row) => row.id,
  );
}

async function batch(limit = 50) {
  return await deleteWorkflowRunRetentionBatch(CUTOFF, limit, Date.now() + 30_000);
}

async function taskDescendants(rootId: string, count: number, shape: "wide" | "deep" = "wide") {
  await getDbClient().run(
    `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO agent_tasks (id, task, parentTaskId, source, isHumanFree, createdAt, lastUpdatedAt)
     SELECT 'child-' || v, 'child',
       CASE WHEN ? = 'wide' OR v = 1 THEN ? ELSE 'child-' || (v - 1) END,
       'workflow', 1, datetime('now'), datetime('now') FROM n`,
    [count, shape, rootId],
  );
}

beforeAll(async () => {
  migrationTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await removeDbFiles();
  initDb(DB_PATH);
  workflowId = (await createWorkflow({ name: "retention", definition: { nodes: [] } })).id;
});

beforeEach(async () => {
  await resetDbRetentionForTests();
  for (const policy of DB_RETENTION_TABLES) delete process.env[policy.envKey];
  delete process.env.DB_RETENTION_DRY_RUN;
  for (const table of [
    "agent_tasks",
    "human_free_reclassify_queue",
    "approval_requests",
    "wait_states",
    "workflow_run_steps",
    "workflow_runs",
    "workflow_run_definitions",
  ]) {
    await getDbClient().run(`DELETE FROM ${table}`);
  }
});

afterAll(async () => {
  await resetDbRetentionForTests();
  delete process.env[DAYS_KEY];
  delete process.env.DB_RETENTION_DRY_RUN;
  closeDb();
  testGlobals.__testMigrationTemplate = migrationTemplate;
  await removeDbFiles();
});

describe("workflow run retention", () => {
  test("disabled and invalid horizons never expire a run", async () => {
    await run("old");
    for (const value of [undefined, "", "0", "-1", "abc", "1.5", "1000001"]) {
      if (value === undefined) delete process.env[DAYS_KEY];
      else process.env[DAYS_KEY] = value;
      await runDbRetentionTick({ now: NOW });
      expect(await ids()).toEqual(["old"]);
      expect(getDbRetentionStats().workflowRuns).toBeUndefined();
    }
  });

  test("uses finishedAt and keeps active, waiting, unknown-age and recent runs", async () => {
    for (const status of ["completed", "failed", "skipped", "cancelled"])
      await run(`old-${status}`, status);
    await run("running", "running");
    await run("waiting", "waiting");
    await run("unknown", "completed", null);
    await run("recent", "completed", RECENT);
    await run("boundary", "completed", CUTOFF);
    await run("before-spaced", "completed", "2026-11-05 11:59:59");
    // The mixed-format cutoff is conservative: ISO rows on its own day wait.
    await run("iso-cutoff-day", "completed", "2026-11-05T11:00:00.000Z");
    process.env[DAYS_KEY] = "1";
    await runDbRetentionTick({ now: NOW });
    expect(await ids()).toEqual([
      "boundary",
      "iso-cutoff-day",
      "recent",
      "running",
      "unknown",
      "waiting",
    ]);
    expect(getDbRetentionStats().workflowRuns).toMatchObject({
      rowsDeleted: 5,
      backlogRemaining: 0,
      drained: true,
    });
  });

  test("dry run reports the current deletion frontier without changing any rows", async () => {
    await run("root");
    await step("parent-step", "root");
    await run("child", "completed", OLD, { parentStepId: "parent-step" });
    await run("independent");
    process.env[DAYS_KEY] = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";
    await runDbRetentionTick({ now: NOW });
    expect(await ids()).toEqual(["child", "independent", "root"]);
    expect(getDbRetentionStats().workflowRuns).toMatchObject({
      rowsDeleted: 0,
      batches: 0,
      backlogRemaining: 2,
      dryRun: true,
    });
  });

  test.each([
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ])("a surviving %s parent keeps its child and its snapshot", async (status) => {
    await getDbClient().run("INSERT INTO workflow_run_definitions VALUES ('pin', '{}', ?)", [OLD]);
    await run("parent", status, RECENT);
    await step("parent-step", "parent");
    await run("child", "completed", OLD, { parentStepId: "parent-step", hash: "pin" });
    expect((await batch()).changes).toBe(0);
    expect(await getChildWorkflowRunId("parent-step", 0)).toBe("child");
    expect(
      await getDbClient().get("SELECT 1 FROM workflow_run_definitions WHERE hash = 'pin'"),
    ).not.toBeNull();
  });

  test.each([
    "running",
    "waiting",
    "recent",
    "unknown",
  ])("a %s descendant protects expired ancestors across old attempts", async (kind) => {
    await run("root", "failed");
    await step("root-step", "root");
    await run("middle", "failed", OLD, { parentStepId: "root-step", attempt: 0 });
    await run("new-attempt", "completed", OLD, { parentStepId: "root-step", attempt: 1 });
    await step("middle-step", "middle");
    await run(
      "leaf",
      kind === "recent" || kind === "unknown" ? "completed" : kind,
      kind === "recent" ? RECENT : kind === "unknown" ? null : OLD,
      { parentStepId: "middle-step" },
    );
    expect((await batch()).changes).toBe(0);
    expect(await ids()).toHaveLength(4);
    expect(await getRunLineageBlock("leaf")).toBeNull();
  });

  test("retires a terminal tree parent first across bounded batches and resumes after interruption", async () => {
    await run("root");
    await step("root-step", "root");
    await run("middle", "failed", OLD, { parentStepId: "root-step" });
    await step("middle-step", "middle");
    await run("leaf", "completed", OLD, { parentStepId: "middle-step" });
    expect((await batch(1)).changes).toBe(1);
    expect(await ids()).toEqual(["leaf", "middle"]);
    expect(await getRunLineageBlock("middle")).not.toBeNull();
    expect(await getChildWorkflowRunId("middle-step", 0)).toBe("leaf");
    process.env[DAYS_KEY] = "1";
    await runDbRetentionTick({ now: NOW });
    expect(await ids()).toEqual([]);
    expect(getDbRetentionStats().workflowRuns).toMatchObject({ rowsDeleted: 2, drained: true });
  });

  test("cyclic and over-depth trees fail closed", async () => {
    await run("cycle-a");
    await step("cycle-a-step", "cycle-a");
    await run("cycle-b", "completed", OLD, { parentStepId: "cycle-a-step" });
    await step("cycle-b-step", "cycle-b");
    await getDbClient().run(
      "UPDATE workflow_runs SET parentStepId = 'cycle-b-step' WHERE id = 'cycle-a'",
    );
    for (let i = 0; i <= 33; i++) {
      await run(`deep-${i}`, "completed", OLD, i ? { parentStepId: `deep-step-${i - 1}` } : {});
      await step(`deep-step-${i}`, `deep-${i}`);
    }
    expect((await batch()).changes).toBe(0);
    expect(await ids()).toHaveLength(36);
  });

  test("unlinks tasks and deletes dependents atomically, then drains overflow classification", async () => {
    await run("old");
    await run("kept", "waiting");
    await step("old-step", "old");
    await step("kept-step", "kept");
    const root = await createTaskExtended("scheduled root", {
      source: "workflow",
      workflowRunId: "old",
    });
    await taskDescendants(root.id, 1100);
    await getDbClient().run(
      "INSERT INTO agent_tasks (id, task, workflowRunStepId, createdAt, lastUpdatedAt) VALUES ('step-only', 'task', 'old-step', datetime('now'), datetime('now'))",
    );
    for (const id of ["old", "kept"]) {
      await getDbClient().run(
        "INSERT INTO approval_requests (id, title, questions, approvers, workflowRunId, workflowRunStepId) VALUES (?, 'approval', '[]', '[]', ?, ?)",
        [id, id, `${id}-step`],
      );
      await getDbClient().run(
        "INSERT INTO wait_states (id, workflowRunId, workflowRunStepId, mode) VALUES (?, ?, ?, 'time')",
        [id, id, `${id}-step`],
      );
    }
    await batch();
    expect(await ids("agent_tasks")).toHaveLength(1102);
    expect(
      await getDbClient().get(
        "SELECT 1 FROM agent_tasks WHERE workflowRunId IS NOT NULL OR workflowRunStepId IS NOT NULL",
      ),
    ).toBeNull();
    expect(await ids("approval_requests")).toEqual(["kept"]);
    expect(await ids("wait_states")).toEqual(["kept"]);
    expect(await ids("workflow_run_steps")).toEqual(["kept-step"]);
    expect(await pendingHumanFreeReclassifications()).toBeGreaterThan(0);
    expect((await drainHumanFreeReclassifyQueue()).remaining).toBe(0);
    expectFlagsMatchLegacy(await storedFlags(), await legacyHumanFreeIds());
    expect(await pendingHumanFreeReclassifications()).toBe(0);
    expect(await getDbClient().query("PRAGMA foreign_key_check")).toEqual([]);
  });

  test.each([
    "wide",
    "deep",
  ] as const)("a large %s task tree commits one classification batch and resumes from the durable queue", async (shape) => {
    await run("old");
    const root = await createTaskExtended("scheduled root", {
      source: "workflow",
      workflowRunId: "old",
    });
    const descendants = HUMAN_FREE_RECLASSIFY_BATCH * 20;
    await taskDescendants(root.id, descendants, shape);
    process.env[DAYS_KEY] = "1";
    const oldBudget = process.env.DB_RETENTION_TICK_BUDGET_MS;
    process.env.DB_RETENTION_TICK_BUDGET_MS = "1000";
    const startedAt = Date.now();
    let clock = startedAt;
    let classifications = 0;
    let changedInline = 0;
    const clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
    const originalRun = getDbClient().run.bind(getDbClient());
    const runSpy = spyOn(getDbClient(), "run").mockImplementation(async (sql, params) => {
      const result = await originalRun(sql, params);
      if (sql.includes("WITH RECURSIVE affected")) {
        classifications++;
        changedInline += result.changes;
        // Model a slow classifier deterministically: a second batch would
        // exhaust the tick and roll back the run deletion before this fix.
        clock += 500;
      }
      return result;
    });
    try {
      await runDbRetentionTick({ now: NOW });
      expect(getDbRetentionStats().workflowRuns).toMatchObject({
        rowsDeleted: 1,
        backlogRemaining: 0,
        outcome: "converged",
        drained: true,
      });
      expect(clock - startedAt).toBeLessThan(1000);
      await runDbRetentionTick({ now: NOW });
      expect(getDbRetentionStats().workflowRuns).toMatchObject({
        rowsDeleted: 0,
        cumulativeRowsDeleted: 1,
        drained: true,
      });
      expect(classifications).toBe(1);
      expect(changedInline).toBe(HUMAN_FREE_RECLASSIFY_BATCH);
    } finally {
      runSpy.mockRestore();
      clockSpy.mockRestore();
      if (oldBudget === undefined) delete process.env.DB_RETENTION_TICK_BUDGET_MS;
      else process.env.DB_RETENTION_TICK_BUDGET_MS = oldBudget;
    }
    expect(await ids()).toEqual([]);
    expect(await ids("agent_tasks")).toHaveLength(descendants + 1);
    expect(await pendingHumanFreeReclassifications()).toBe(1);
    closeDb();
    initDb(DB_PATH);
    expect(await pendingHumanFreeReclassifications()).toBe(1);
    let passes = 0;
    while ((await pendingHumanFreeReclassifications()) > 0) {
      const result = await drainHumanFreeReclassifyQueue({ maxBatches: 1 });
      expect(result.batches).toBe(1);
      expect(result.changed).toBeLessThanOrEqual(HUMAN_FREE_RECLASSIFY_BATCH);
      expect(++passes).toBeLessThan(50);
    }
    expect(passes).toBeGreaterThan(1);
    expectFlagsMatchLegacy(await storedFlags(), await legacyHumanFreeIds());
  });

  test("reclaims only the deleted runs' unreferenced snapshots in the same transaction", async () => {
    for (const hash of ["orphan", "shared", "only-old"])
      await getDbClient().run("INSERT INTO workflow_run_definitions VALUES (?, '{}', ?)", [
        hash,
        OLD,
      ]);
    await run("old-shared", "completed", OLD, { hash: "shared" });
    await run("old-only", "completed", OLD, { hash: "only-old" });
    await run("retained", "waiting", OLD, { hash: "shared" });
    await batch();
    expect(
      await getDbClient().query("SELECT hash FROM workflow_run_definitions ORDER BY hash"),
    ).toEqual([{ hash: "orphan" }, { hash: "shared" }]);
    await getDbClient().run("UPDATE workflow_runs SET status = 'completed' WHERE id = 'retained'");
    await batch();
    expect(await getDbClient().query("SELECT hash FROM workflow_run_definitions")).toEqual([
      { hash: "orphan" },
    ]);
  });

  test("failure after reclassification rolls back tasks, runs, steps, snapshots and queued work", async () => {
    await getDbClient().run("INSERT INTO workflow_run_definitions VALUES ('pin', '{}', ?)", [OLD]);
    await run("old", "completed", OLD, { hash: "pin" });
    await step("old-step", "old");
    const task = await createTaskExtended("scheduled root", {
      source: "workflow",
      workflowRunId: "old",
    });
    await taskDescendants(task.id, 1100);
    await getDbClient().run(
      "CREATE TEMP TRIGGER fail_retention BEFORE DELETE ON workflow_run_definitions BEGIN SELECT RAISE(ABORT, 'rollback-retention'); END",
    );
    try {
      await expect(batch()).rejects.toThrow("rollback-retention");
      expect(await ids()).toEqual(["old"]);
      expect(await ids("workflow_run_steps")).toEqual(["old-step"]);
      expect(
        await getDbClient().get("SELECT workflowRunId, isHumanFree FROM agent_tasks WHERE id = ?", [
          task.id,
        ]),
      ).toEqual({ workflowRunId: "old", isHumanFree: 1 });
      expect(await getDbClient().get("SELECT hash FROM workflow_run_definitions")).toEqual({
        hash: "pin",
      });
      expect(await pendingHumanFreeReclassifications()).toBe(0);
      expectFlagsMatchLegacy(await storedFlags(), await legacyHumanFreeIds());
    } finally {
      await getDbClient().run("DROP TRIGGER fail_retention");
    }
  });

  test("drains catch-up work with no batch exceeding the configured ceiling", async () => {
    await getDbClient().run(
      `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 230)
       INSERT INTO workflow_runs (id, workflowId, status, finishedAt)
       SELECT 'bulk-' || v, ?, 'completed', ? FROM n`,
      [workflowId, OLD],
    );
    expect((await batch(7)).changes).toBe(7);
    process.env[DAYS_KEY] = "1";
    await runDbRetentionTick({ now: NOW });
    expect(await ids()).toEqual([]);
    const stats = getDbRetentionStats().workflowRuns;
    expect(stats).toMatchObject({ rowsDeleted: 223, drained: true, backlogRemaining: 0 });
    expect(stats!.batches).toBeGreaterThan(2);
    expect(stats!.batchSize).toBeLessThanOrEqual(100);
  });

  test("a deadline during task classification rolls back the entire batch", async () => {
    await run("old");
    const task = await createTaskExtended("scheduled root", {
      source: "workflow",
      workflowRunId: "old",
    });
    const deadline = Date.now() + 30_000;
    const originalRun = getDbClient().run.bind(getDbClient());
    let clockSpy: ReturnType<typeof spyOn> | undefined;
    const runSpy = spyOn(getDbClient(), "run").mockImplementation(async (sql, params) => {
      const result = await originalRun(sql, params);
      if (sql.includes("WITH RECURSIVE affected"))
        clockSpy = spyOn(Date, "now").mockReturnValue(deadline + 1);
      return result;
    });
    try {
      await expect(deleteWorkflowRunRetentionBatch(CUTOFF, 1, deadline)).rejects.toBeInstanceOf(
        DbTransactionDeadlineError,
      );
    } finally {
      runSpy.mockRestore();
      clockSpy?.mockRestore();
    }
    expect(await ids()).toEqual(["old"]);
    expect(
      await getDbClient().get("SELECT workflowRunId, isHumanFree FROM agent_tasks WHERE id = ?", [
        task.id,
      ]),
    ).toEqual({ workflowRunId: "old", isHumanFree: 1 });
  });

  test("budget rollback shrinks batches, keeps the backlog and catches up on the next tick", async () => {
    await run("old");
    process.env[DAYS_KEY] = "1";
    const batchSpy = spyOn(retentionDb, "deleteWorkflowRunRetentionBatch").mockRejectedValue(
      new DbTransactionDeadlineError(),
    );
    try {
      await runDbRetentionTick({ now: NOW });
      expect(await ids()).toEqual(["old"]);
      const stats = getDbRetentionStats().workflowRuns;
      expect(stats).toMatchObject({
        rowsDeleted: 0,
        batches: 0,
        outcome: "budget_exhausted",
        drained: false,
        backlogRemaining: 1,
      });
      expect(stats!.batchSize).toBeLessThan(10);
      expect(stats!.lastError).toBeUndefined();
    } finally {
      batchSpy.mockRestore();
    }
    await runDbRetentionTick({ now: NOW });
    expect(await ids()).toEqual([]);
    expect(getDbRetentionStats().workflowRuns).toMatchObject({
      cumulativeRowsDeleted: 1,
      drained: true,
    });
  });

  test("eligibility, count, recursive links and every incoming FK use indexes", async () => {
    const client = getDbClient();
    const statements = sweepStatements(POLICY, 1, NOW);
    for (const [sql, params] of [
      [WORKFLOW_RETENTION_CANDIDATES_SQL, [CUTOFF, 50]],
      [statements.backlogSql, statements.params],
      [statements.deleteSql, [...statements.params, 50]],
    ] as const) {
      const plan = (
        await client.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [...params])
      )
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("idx_workflow_runs_retention");
      expect(plan).toContain("idx_workflow_runs_parentStep_attempt");
      expect(plan).toMatch(/idx_wrs_runId/);
      expect(plan).not.toMatch(/SCAN (r|child|step|workflow_runs|workflow_run_steps)(?!\w| USING)/);
    }
    for (const [table, column, index] of [
      ["agent_tasks", "workflowRunId", "idx_agent_tasks_workflow_run"],
      ["agent_tasks", "workflowRunStepId", "idx_agent_tasks_workflowRunStepId"],
      ["workflow_run_steps", "runId", "idx_wrs_runId"],
      ["workflow_runs", "definitionHash", "idx_workflow_runs_definitionHash"],
      ["approval_requests", "workflowRunId", "idx_approval_requests_workflow"],
      ["approval_requests", "workflowRunStepId", "idx_approval_requests_workflow_step"],
      ["wait_states", "workflowRunId", "idx_wait_states_run"],
      ["wait_states", "workflowRunStepId", "idx_wait_states_step"],
    ]) {
      const plan = await client.query<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE ${column} = ?`,
        ["x"],
      );
      expect(plan.map((row) => row.detail).join("\n")).toContain(index!);
    }
  });
});
