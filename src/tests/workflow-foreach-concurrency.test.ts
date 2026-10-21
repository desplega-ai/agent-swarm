import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  detachTaskFromWorkflowRunStep,
  failTask,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowRunStep } from "../types";
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import {
  _resetForeachOwnershipForTests,
  drainForeachDrives,
  driveForeach,
} from "../workflows/foreach-driver";
import { buildForeachAggregate } from "../workflows/foreach-join";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { setupWorkflowResumeListener } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-foreach-concurrency.sqlite";

const deps: ExecutorDependencies = {
  db,
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};
const registry = createExecutorRegistry(deps);

let teardown: (() => void) | undefined;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Capped", status: "idle" })).id;
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  teardown?.();
  await drainForeachDrives();
  closeDb();
  await removeDbFiles();
});

describe("foreach config validation", () => {
  test("failurePolicy accepts the two policies and rejects anything else", () => {
    for (const policy of ["fail-fast", "collect-outcomes"]) {
      expect(validateDefinition(fanOut({ failurePolicy: policy })).valid).toBe(true);
    }
    const invalid = validateDefinition(fanOut({ failurePolicy: "best-effort" }));
    expect(invalid.valid).toBe(false);
    expect(
      invalid.errors.some((error) => error.includes('Node "fan" foreach config.failurePolicy')),
    ).toBe(true);
  });
});

describe("foreach concurrency cap", () => {
  test("concurrency 2 over 5 items keeps at most 2 in flight; each completion starts one more", async () => {
    const runId = await startRun(5, { concurrency: 2 });
    expect(await inFlightTasks(runId)).toHaveLength(2);
    expect((await children(runId)).filter((step) => step.status === "pending")).toHaveLength(3);

    for (let done = 1; done <= 5; done++) {
      const [next] = await inFlightTasks(runId);
      await completeTask(next!.taskId, `out ${next!.nodeId}`);
      await waitForStep(next!.stepId, "completed");
      await drainForeachDrives();
      const remaining = 5 - done;
      expect(await inFlightTasks(runId)).toHaveLength(Math.min(2, remaining));
      expect(await boundTaskCount(runId)).toBe(Math.min(5, done + 2));
    }

    const run = await waitForRun(runId, (r) => r.status === "completed");
    const aggregate = (run.context as Record<string, unknown>).fan as {
      okCount: number;
      failedCount: number;
    };
    expect(aggregate).toMatchObject({ okCount: 5, failedCount: 0 });
  });

  test("the cap holds after a restart: two recovery sweeps start no new item", async () => {
    const runId = await startRun(5, { concurrency: 2 });
    const inFlight = await inFlightTasks(runId);
    expect(inFlight).toHaveLength(2);

    // A restart drops in-process ownership; one in-flight item is left
    // `running` with no owner (crash between claim and park).
    _resetForeachOwnershipForTests();
    await setStatus(inFlight[0]!.stepId, "running");

    await recoverIncompleteRuns(registry);
    await recoverIncompleteRuns(registry);
    await drainForeachDrives();

    expect(await boundTaskCount(runId)).toBe(2);
    const steps = await children(runId);
    expect(steps.filter((step) => step.status === "waiting")).toHaveLength(2);
    expect(steps.filter((step) => step.status === "pending")).toHaveLength(3);
    // The orphan reconnected to its own task instead of starting a second one.
    expect((await getTaskByWorkflowRunStepId(inFlight[0]!.stepId))?.id).toBe(inFlight[0]!.taskId);
  });

  test("concurrent drives never exceed the cap", async () => {
    const runId = await startRun(5, { concurrency: 2 });
    // Back to the state right after materialization: every item queued.
    for (const { taskId, stepId } of await inFlightTasks(runId)) {
      await detachTaskFromWorkflowRunStep(taskId);
      await setStatus(stepId, "pending");
    }
    _resetForeachOwnershipForTests();

    await Promise.all([
      driveForeach(runId, "fan", registry),
      driveForeach(runId, "fan", registry),
      driveForeach(runId, "fan", registry),
    ]);

    const steps = await children(runId);
    expect(
      steps.filter((step) => step.status === "running" || step.status === "waiting"),
    ).toHaveLength(2);
    expect(await boundTaskCount(runId)).toBe(2);
  });
});

describe("foreach failure policies", () => {
  test("fail-fast cancels queued items, never starts them, and fails the run", async () => {
    const runId = await startRun(4, { concurrency: 1, failurePolicy: "fail-fast" });
    const [first] = await inFlightTasks(runId);
    await completeTask(first!.taskId, "first ok");
    await waitForStep(first!.stepId, "completed");
    await drainForeachDrives();

    const [second] = await inFlightTasks(runId);
    expect(second!.nodeId).toBe("fan#i1");
    await failTask(second!.taskId, "item two broke");
    const run = await waitForRun(runId, (r) => r.status === "failed");
    expect(run.error).toContain("item two broke");

    const steps = await children(runId);
    const byNode = Object.fromEntries(steps.map((step) => [step.nodeId, step]));
    expect(byNode["fan#i0"]?.status).toBe("completed");
    expect(byNode["fan#i1"]?.status).toBe("failed");
    for (const nodeId of ["fan#i2", "fan#i3"]) {
      expect(byNode[nodeId]?.status).toBe("cancelled");
      expect(byNode[nodeId]?.error).toBe("not started: fail-fast after item i1 failed");
      expect(await getTaskByWorkflowRunStepId(byNode[nodeId]!.id)).toBeNull();
    }
    // The parent stays open, so a run retry can resume it.
    expect((await stepByNodeId(runId, "fan"))?.status).toBe("waiting");
  });

  test("fail-fast lets an in-flight sibling finish without reviving the run", async () => {
    const runId = await startRun(3, { concurrency: 2, failurePolicy: "fail-fast" });
    const [first, second] = await inFlightTasks(runId);
    await failTask(first!.taskId, "first broke");
    await waitForRun(runId, (r) => r.status === "failed");
    expect((await stepByNodeId(runId, "fan#i2"))?.status).toBe("cancelled");

    await completeTask(second!.taskId, "second finished late");
    await waitForStep(second!.stepId, "completed");
    await drainForeachDrives();
    expect((await getWorkflowRun(runId))?.status).toBe("failed");
    expect(await stepByNodeId(runId, "after")).toBeUndefined();
  });

  test("collect-outcomes runs every item and routes the join with the failures counted", async () => {
    // onNodeFailure stays the default "fail": the node's policy wins.
    const runId = await startRun(4, { concurrency: 2, failurePolicy: "collect-outcomes" });
    let failed = false;
    for (;;) {
      const [next] = await inFlightTasks(runId);
      if (!next) break;
      if (!failed) {
        await failTask(next.taskId, "one item broke");
        failed = true;
      } else {
        await completeTask(next.taskId, `out ${next.nodeId}`);
      }
      await waitForStep(next.stepId, "completed");
      await drainForeachDrives();
    }
    const run = await waitForRun(runId, (r) => r.status === "completed");
    const aggregate = (run.context as Record<string, unknown>).fan as {
      okCount: number;
      failedCount: number;
      results: Array<{ itemKey: string; status: string }>;
    };
    expect(aggregate.okCount).toBe(3);
    expect(aggregate.failedCount).toBe(1);
    expect(aggregate.results.find((result) => result.itemKey === "i0")?.status).toBe("failed");
    expect((await stepByNodeId(runId, "after"))?.status).toBe("completed");
    expect(run.error ?? "").not.toContain("Partial failure");
  });

  test("a cancelled item counts as failed under collect-outcomes", async () => {
    const runId = await startRun(2, { failurePolicy: "collect-outcomes" });
    const [first, second] = await inFlightTasks(runId);
    await cancelTask(first!.taskId, "operator cancelled");
    await waitForStep(first!.stepId, "completed");
    await completeTask(second!.taskId, "ok");
    const run = await waitForRun(runId, (r) => r.status === "completed");
    expect((run.context as Record<string, unknown>).fan).toMatchObject({
      okCount: 1,
      failedCount: 1,
    });
  });

  test("a cancelled item counts as failed and cancelled in the aggregate under fail-fast", () => {
    const row = (nodeId: string, status: string, index: number) =>
      ({ nodeId, status, input: { itemKey: nodeId.slice(4), index }, output: null }) as never;
    const aggregate = buildForeachAggregate([
      row("fan#a", "completed", 0),
      row("fan#b", "failed", 1),
      row("fan#c", "cancelled", 2),
    ]);
    expect(aggregate).toMatchObject({ okCount: 1, failedCount: 2, cancelledCount: 1 });
  });

  test("without concurrency or failurePolicy the aggregate keeps its exact shape", async () => {
    const runId = await startRun(2, {});
    for (const { taskId } of await inFlightTasks(runId)) await completeTask(taskId, "ok");
    const run = await waitForRun(runId, (r) => r.status === "completed");
    const aggregate = (run.context as Record<string, unknown>).fan as Record<string, unknown>;
    expect(Object.keys(aggregate).sort()).toEqual(["failedCount", "okCount", "results"]);
  });
});

/** `fan`, an agent-task foreach over the trigger items, then `after`. */
function fanOut(extra: Record<string, unknown>): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "fan",
        type: "foreach",
        config: {
          over: "{{trigger.items}}",
          itemKey: "id",
          ...extra,
          body: { type: "agent-task", config: { agentId, template: "Item {{item.id}}" } },
        },
        next: "after",
      },
      { id: "after", type: "notify", config: { channel: "swarm", template: "done" } },
    ],
  };
}

async function startRun(count: number, extra: Record<string, unknown>): Promise<string> {
  const workflow = await makeWorkflow(fanOut(extra));
  const items = Array.from({ length: count }, (_, index) => ({ id: `i${index}` }));
  const runId = await startWorkflowExecution(workflow, { items }, registry);
  await drainForeachDrives();
  return runId;
}

function makeWorkflow(definition: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({ name: `foreach-cap-${crypto.randomUUID()}`, definition });
}

async function children(runId: string): Promise<WorkflowRunStep[]> {
  return (await getWorkflowRunStepsByRunId(runId)).filter((step) => step.nodeId.startsWith("fan#"));
}

async function stepByNodeId(runId: string, nodeId: string) {
  return (await getWorkflowRunStepsByRunId(runId)).find((step) => step.nodeId === nodeId);
}

/** In-flight items with their bound task, in item order. */
async function inFlightTasks(
  runId: string,
): Promise<Array<{ stepId: string; nodeId: string; taskId: string }>> {
  const result = [];
  for (const step of await children(runId)) {
    if (step.status !== "waiting" && step.status !== "running") continue;
    const task = await getTaskByWorkflowRunStepId(step.id);
    if (task) result.push({ stepId: step.id, nodeId: step.nodeId, taskId: task.id });
  }
  return result;
}

async function boundTaskCount(runId: string): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_tasks t
       JOIN workflow_run_steps s ON s.id = t.workflowRunStepId
       WHERE s.runId = ? AND s.nodeId LIKE 'fan#%'`,
    [runId],
  );
  return row?.count ?? 0;
}

async function setStatus(stepId: string, status: string): Promise<void> {
  await getDbClient().run("UPDATE workflow_run_steps SET status = ? WHERE id = ?", [
    status,
    stepId,
  ]);
}

async function waitForStep(stepId: string, status: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await db.getWorkflowRunStep(stepId))?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for step ${stepId} to be ${status}`);
}

async function waitForRun(
  runId: string,
  done: (run: WorkflowRun) => boolean,
  timeoutMs = 3_000,
): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  let run: WorkflowRun | null = null;
  while (Date.now() < deadline) {
    run = await getWorkflowRun(runId);
    if (run && done(run)) return run;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for run ${runId}; last status ${run?.status} ${run?.error}`);
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}
