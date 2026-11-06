import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  initDb,
} from "../be/db";
import { computeWorkflowWindow, LIVE_MAX_RUNS } from "../be/savings/compute";
import { DEFAULT_OPS } from "../be/savings/model";

const TEST_DB_PATH = "./test-savings-compute.sqlite";
const WINDOW = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z" };
const DEFINITION = {
  nodes: [
    { id: "fetch", type: "script", config: { script: "await a(); await b(); await c();" } },
    { id: "ping", type: "notify", config: {} },
    { id: "sw", type: "swarm-script", config: { scriptName: "not-in-catalog" } },
    { id: "agent", type: "agent-task", config: {} },
  ],
};

// The preload swaps file DBs for an in-memory template copy; the route's
// bounded executor reads the DB file from a child process, so opt out here.
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedSavingsTemplate?: Uint8Array;
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

describe("savings compute", () => {
  let agentId: string;
  let workflowId: string;
  let busyWorkflowId: string;

  async function run(opts: {
    trigger: "schedule" | "manual";
    status: string;
    startedAt: string;
    steps: string[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    await createWorkflowRun({ id, workflowId, triggerType: opts.trigger });
    await getDbClient().run("UPDATE workflow_runs SET status=?, startedAt=? WHERE id=?", [
      opts.status,
      opts.startedAt,
      id,
    ]);
    for (const nodeId of opts.steps) {
      const node = DEFINITION.nodes.find((n) => n.id === nodeId);
      const stepId = crypto.randomUUID();
      await createWorkflowRunStep({ id: stepId, runId: id, nodeId, nodeType: node?.type ?? "" });
      // Every step lasts 2 s, except the agent step (10 s, which is not compute time).
      const secs = nodeId === "agent" ? 10 : 2;
      const finished = new Date(Date.parse(opts.startedAt) + secs * 1000).toISOString();
      await getDbClient().run(
        "UPDATE workflow_run_steps SET status='completed', startedAt=?, finishedAt=? WHERE id=?",
        [opts.startedAt, finished, stepId],
      );
    }
    return id;
  }

  async function agentTask(runId: string, usd: number, ms: number): Promise<string> {
    const task = await createTaskExtended(`savings fixture ${usd}`, {
      agentId,
      source: "workflow",
      workflowRunId: runId,
    });
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: task.id,
      agentId,
      totalCostUsd: usd,
      durationMs: ms,
      numTurns: 3,
      model: "claude-opus-5-5",
    });
    return task.id;
  }

  beforeAll(async () => {
    testGlobals.__savedSavingsTemplate = testGlobals.__testMigrationTemplate;
    testGlobals.__testMigrationTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    agentId = (await createAgent({ name: "savings-agent", isLead: false, status: "idle" })).id;
    workflowId = (await createWorkflow({ name: "savings-fixture", definition: DEFINITION })).id;
    busyWorkflowId = (await createWorkflow({ name: "savings-busy", definition: DEFINITION })).id;

    // Three scheduled runs; the first created an agent task (an effect run).
    const s1 = await run({
      trigger: "schedule",
      status: "completed",
      startedAt: "2026-10-02T10:00:00.000Z",
      steps: ["fetch", "ping"],
    });
    await agentTask(s1, 1, 1_800_000);
    for (const startedAt of ["2026-10-03T10:00:00.000Z", "2026-10-04T10:00:00.000Z"]) {
      await run({ trigger: "schedule", status: "completed", startedAt, steps: ["fetch", "ping"] });
    }
    // One manual run with an agent node, its session and a lead follow-up review.
    const m = await run({
      trigger: "manual",
      status: "completed",
      startedAt: "2026-10-05T10:00:00.000Z",
      steps: ["fetch", "sw", "agent"],
    });
    const worker = await agentTask(m, 2, 3_600_000);
    const followUp = await createTaskExtended("Worker task completed: savings fixture", {
      agentId,
      parentTaskId: worker,
    });
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: followUp.id,
      agentId,
      totalCostUsd: 0.5,
      durationMs: 60_000,
      numTurns: 1,
      model: "claude-opus-5-5",
    });
    // A skipped run counts as a run but substitutes nothing.
    await run({
      trigger: "schedule",
      status: "skipped",
      startedAt: "2026-10-06T10:00:00.000Z",
      steps: [],
    });
    // Outside the window: ignored.
    await run({
      trigger: "manual",
      status: "completed",
      startedAt: "2026-09-20T10:00:00.000Z",
      steps: ["fetch"],
    });

    // More runs than the live path handles.
    await getDbClient().run(
      `INSERT INTO workflow_runs (id, workflowId, triggerType, startedAt)
       WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
       SELECT 'busy-' || i, ?, 'event', '2026-10-10T00:00:00.000Z' FROM seq`,
      [LIVE_MAX_RUNS + 1, busyWorkflowId],
    );
  });

  afterAll(async () => {
    closeDb();
    testGlobals.__testMigrationTemplate = testGlobals.__savedSavingsTemplate;
    testGlobals.__savedSavingsTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
  });

  test("facts match the hand-computed fixture", async () => {
    const out = await computeWorkflowWindow({ id: workflowId, definition: DEFINITION }, WINDOW);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.facts).toEqual({
      runs: 5,
      countedRuns: 4,
      schedRuns: 3,
      schedEffectRuns: 1,
      eventRuns: 0,
      // s1 and the manual run created agent tasks.
      effectRuns: 2,
      effectOpsSum: 4 + 3 + DEFAULT_OPS,
      // 3 scheduled runs x (fetch 3 + ping 1) + manual (fetch 3 + sw DEFAULT_OPS + agent 0)
      opsSum: 3 * 4 + 3 + DEFAULT_OPS,
      agentTasks: 2,
      agentUsd: 3,
      agentMs: 5_400_000,
      followupUsd: 0.5,
      childTaskUsd: 0,
      childTaskMs: 0,
      recordedLlmUsd: 0,
      estimatedLlmUsd: 0,
      // 6 scheduled steps + fetch + sw, 2 s each; the agent step is excluded.
      computeSecs: expect.closeTo(16, 3) as unknown as number,
    });
    // One bucket per UTC start day; the skipped run still counts as a run.
    expect(out.byDay.map((d) => [d.day, d.runs, d.countedRuns, d.schedEffectRuns])).toEqual([
      ["2026-10-02", 1, 1, 1],
      ["2026-10-03", 1, 1, 0],
      ["2026-10-04", 1, 1, 0],
      ["2026-10-05", 1, 1, 0],
      ["2026-10-06", 1, 0, 0],
    ]);
    expect(out.byDay[0]).toMatchObject({ agentTasks: 1, agentUsd: 1, opsSum: 4 });
    expect(out.byDay[3]).toMatchObject({ agentTasks: 1, agentUsd: 2, followupUsd: 0.5 });
  });

  test("negative control: an unknown workflow id has no runs", async () => {
    const out = await computeWorkflowWindow({ id: "no-such-workflow", definition: {} }, WINDOW);
    expect(out).toEqual({ status: "ok", facts: expect.objectContaining({ runs: 0 }), byDay: [] });
  });

  test("a workflow above the live limit is refused before any step scan", async () => {
    const out = await computeWorkflowWindow({ id: busyWorkflowId, definition: DEFINITION }, WINDOW);
    expect(out).toEqual({ status: "too-many-runs", runs: LIVE_MAX_RUNS + 1 });
  });
});
