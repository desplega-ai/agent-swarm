import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  deleteWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { getExecutorRegistry } from "../workflows";
import { isWorkflowRunActive, walkGraph } from "../workflows/engine";
import { ScriptExecutor } from "../workflows/executors/script";
import { recoverIncompleteRuns } from "../workflows/recovery";

const dbPath = `./test-workflow-live-recovery-${crypto.randomUUID()}.sqlite`;
const workflowIds: string[] = [];
const output = { exitCode: 0, stdout: "done", stderr: "" };

beforeAll(() => initDb(dbPath));
afterAll(async () => {
  for (const id of workflowIds) await deleteWorkflow(id);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(dbPath + suffix).catch(() => {});
});

test("periodic heartbeat leaves an in-flight long script owned and activates its successor once", async () => {
  const workflow = await createWorkflow({
    name: "live recovery regression",
    definition: {
      nodes: [
        {
          id: "long-script",
          type: "script",
          config: { runtime: "bash", script: "sleep 90", timeout: 120_000 },
          next: "successor",
        },
        { id: "successor", type: "script", config: { runtime: "bash", script: "echo done" } },
      ],
    },
  });
  workflowIds.push(workflow.id);
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id, triggerType: "manual" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  // Hold the executor at an explicit barrier instead of sleeping for 90 seconds.
  // A duplicate invocation returns immediately so the broken recovery fails
  // assertions rather than hanging the test.
  const executor = spyOn(ScriptExecutor.prototype, "run").mockImplementation(async (input) => {
    calls.push(input.meta.nodeId);
    if (calls.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return { status: "success", output };
  });
  const walking = walkGraph(
    workflow.definition,
    runId,
    {},
    [workflow.definition.nodes[0]!],
    getExecutorRegistry(),
    workflow.id,
  );
  try {
    await entered.promise;
    for (let sweep = 0; sweep < 2; sweep++) {
      const findings = await codeLevelTriage();
      expect(findings.staleCleanup.workflowRuns).toBe(0);
      const run = await getWorkflowRun(runId);
      expect(run?.status).toBe("running");
      expect(run?.finishedAt).toBeFalsy();
      expect(calls).toEqual(["long-script"]);
    }
    release.resolve();
    await walking;
    expect(calls).toEqual(["long-script", "successor"]);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    expect((await getWorkflowRunStepsByRunId(runId)).map((step) => step.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(isWorkflowRunActive(runId)).toBe(false);
  } finally {
    release.resolve();
    await walking;
    executor.mockRestore();
  }
});

test("an interrupted run without a live walk still recovers and executes its successor", async () => {
  const workflow = await createWorkflow({
    name: "interrupted recovery control",
    definition: {
      nodes: [
        {
          id: "first",
          type: "script",
          config: { runtime: "bash", script: "echo first" },
          next: "last",
        },
        { id: "last", type: "script", config: { runtime: "bash", script: "echo last" } },
      ],
    },
  });
  workflowIds.push(workflow.id);
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id, triggerType: "manual" });
  const calls: string[] = [];
  const executor = spyOn(ScriptExecutor.prototype, "run").mockImplementation(async (input) => {
    calls.push(input.meta.nodeId);
    return { status: "success", output };
  });
  try {
    expect(await recoverIncompleteRuns(getExecutorRegistry())).toBe(1);
    expect(calls).toEqual(["first", "last"]);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    expect(isWorkflowRunActive(runId)).toBe(false);
  } finally {
    executor.mockRestore();
  }
});
