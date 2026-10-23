import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  failTask,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  initDb,
  updateWorkflowRunStep,
} from "../be/db";
import {
  type AgentTask,
  SUPERSEDED_WORKFLOW_TASK_REASON,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunStep,
} from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import type { ForeachOutput } from "../workflows/executors/foreach";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { drainForeachDrives } from "../workflows/foreach-driver";
import {
  cancelWorkflowRun,
  retryFailedRun,
  setupWorkflowResumeListener,
} from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";

const TEST_DB_PATH = "./test-workflow-foreach-supersede-retry.sqlite";

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
  agentId = (await createAgent({ name: "Fanned", status: "idle" })).id;
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterEach(async () => {
  stopRetryPoller();
  await drainForeachDrives();
});

afterAll(async () => {
  teardown?.();
  stopRetryPoller();
  await drainForeachDrives();
  closeDb();
  await removeDbFiles();
});

describe("supersede retry for a foreach agent-task child", () => {
  test("a cut item is re-dispatched once and the join counts the retry's result", async () => {
    const runId = await startRun(2, {});
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    const queued = await waitForQueuedRetry(runId, "fan#i0");
    expect(queued.retryCount).toBe(1);
    expect(queued.error).toBe(SUPERSEDED_WORKFLOW_TASK_REASON);
    expect((await getWorkflowRun(runId))!.status).toBe("waiting");

    // The sibling finishing does not close the join over the queued item.
    await completeTask((await boundTask(runId, "fan#i1")).id, "i1 done");
    await waitForStep(runId, "fan#i1", "completed");
    expect((await stepByNodeId(runId, "fan"))!.status).toBe("waiting");
    expect((await getWorkflowRun(runId))!.status).toBe("waiting");

    const retried = await redrive(runId, "fan#i0", cut);
    expect((await stepByNodeId(runId, "fan#i0"))!.id).toBe(queued.id);

    await completeTask(retried.id, "i0 done");
    const run = await waitForRun(runId, (r) => r.status === "completed");
    const aggregate = (run.context as Record<string, unknown>).fan as ForeachOutput;
    expect(aggregate.okCount).toBe(2);
    expect(aggregate.failedCount).toBe(0);
    expect(aggregate.results.find((r) => r.itemKey === "i0")?.status).toBe("completed");
    expect((await stepByNodeId(runId, "after"))?.status).toBe("completed");
    expect((await children(runId)).filter((s) => s.nodeId === "fan#i0")).toHaveLength(1);
  });

  test("a second cut exhausts the retry and the item settles failed into the join", async () => {
    const runId = await startRun(2, { failurePolicy: "collect-outcomes" });
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    await waitForQueuedRetry(runId, "fan#i0");
    const retried = await redrive(runId, "fan#i0", cut);

    // Under collect-outcomes a failed item settles as completed-with-error,
    // which the aggregate counts as failed.
    await failTask(retried.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    const settled = await waitForStep(runId, "fan#i0", "completed");
    expect(settled.error).toContain(SUPERSEDED_WORKFLOW_TASK_REASON);
    expect(settled.retryCount).toBe(1);
    expect(settled.nextRetryAt).toBeFalsy();
    expect((await getTaskByWorkflowRunStepId(settled.id))!.id).toBe(retried.id);

    await completeTask((await boundTask(runId, "fan#i1")).id, "i1 done");
    const run = await waitForRun(runId, (r) => r.status === "completed");
    const aggregate = (run.context as Record<string, unknown>).fan as ForeachOutput;
    expect(aggregate.okCount).toBe(1);
    expect(aggregate.failedCount).toBe(1);
    expect(aggregate.results.find((r) => r.itemKey === "i0")?.status).toBe("failed");
  });

  test("a non-supersede item failure settles failed exactly as before", async () => {
    const runId = await startRun(2, {});
    const task = await boundTask(runId, "fan#i0");

    await failTask(task.id, "agent crashed");
    const run = await waitForRun(runId, (r) => r.status === "failed");
    expect(run.error).toContain("agent crashed");
    const failed = (await stepByNodeId(runId, "fan#i0"))!;
    expect(failed.status).toBe("failed");
    expect(failed.retryCount).toBe(0);
    expect(failed.nextRetryAt).toBeFalsy();
    expect((await getTaskByWorkflowRunStepId(failed.id))!.id).toBe(task.id);
  });

  test("parent retry {maxRetries:0} opts the items out", async () => {
    const runId = await startRun(2, {}, { maxRetries: 0 });
    const task = await boundTask(runId, "fan#i0");

    await failTask(task.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    const run = await waitForRun(runId, (r) => r.status === "failed");
    expect(run.error).toContain(SUPERSEDED_WORKFLOW_TASK_REASON);
    const failed = (await stepByNodeId(runId, "fan#i0"))!;
    expect(failed.retryCount).toBe(0);
    expect(failed.nextRetryAt).toBeFalsy();
    expect((await getTaskByWorkflowRunStepId(failed.id))!.id).toBe(task.id);
  });

  test("a queued item keeps its concurrency slot until the retry starts it", async () => {
    const runId = await startRun(2, { concurrency: 1 });
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    await waitForQueuedRetry(runId, "fan#i0");
    await drainForeachDrives();
    expect((await stepByNodeId(runId, "fan#i1"))!.status).toBe("pending");

    const retried = await redrive(runId, "fan#i0", cut);
    expect((await stepByNodeId(runId, "fan#i1"))!.status).toBe("pending");

    await completeTask(retried.id, "i0 done");
    const next = await waitFor(
      async () => getTaskByWorkflowRunStepId((await stepByNodeId(runId, "fan#i1"))!.id),
      "i1 started",
    );
    await completeTask(next.id, "i1 done");
    const run = await waitForRun(runId, (r) => r.status === "completed");
    expect(((run.context as Record<string, unknown>).fan as ForeachOutput).okCount).toBe(2);
  });

  test("fail-fast cancels a queued retry so the poller does not revive the run", async () => {
    const runId = await startRun(2, {});
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    await waitForQueuedRetry(runId, "fan#i0");
    await failTask((await boundTask(runId, "fan#i1")).id, "agent crashed");
    await waitForRun(runId, (r) => r.status === "failed");

    const cancelled = (await stepByNodeId(runId, "fan#i0"))!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nextRetryAt).toBeFalsy();

    startRetryPoller(registry, 10);
    await Bun.sleep(50);
    expect((await getWorkflowRun(runId))!.status).toBe("failed");
    expect(await getTaskByWorkflowRunStepId(cancelled.id)).toBeNull();
  });
});

describe("a queued item retry never revives a failed run", () => {
  test("another branch failing the run retires the queued retry", async () => {
    const runId = await startParallelRun();
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    const queued = await waitForQueuedRetry(runId, "fan#i0");
    await failTask((await boundTask(runId, "other")).id, "parallel branch crashed");
    await waitForRun(runId, (r) => r.status === "failed");

    startRetryPoller(registry, 10);
    const retired = await waitFor(async () => {
      const step = await getWorkflowRunStep(queued.id);
      return step?.nextRetryAt == null ? step : null;
    }, "queued retry retired");
    stopRetryPoller();
    await drainForeachDrives();

    expect(retired.status).toBe("failed");
    expect(retired.error).toBe(SUPERSEDED_WORKFLOW_TASK_REASON);
    expect((await getWorkflowRun(runId))!.status).toBe("failed");
    expect(await getTaskByWorkflowRunStepId(queued.id)).toBeNull();

    await expectRunRetryStartsItemOnce(runId, queued.id, cut);
  });

  test("a run retry supersedes an item retry still queued when the run failed", async () => {
    const runId = await startParallelRun();
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    const queued = await waitForQueuedRetry(runId, "fan#i0");
    await failTask((await boundTask(runId, "other")).id, "parallel branch crashed");
    await waitForRun(runId, (r) => r.status === "failed");

    // No poller tick between the failure and the run retry: the item's
    // queued retry is still due when the run goes live again.
    await expectRunRetryStartsItemOnce(runId, queued.id, cut);
  });

  test("a cancelled run keeps its queued item retry inert", async () => {
    const runId = await startRun(2, {});
    const cut = await boundTask(runId, "fan#i0");

    await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
    const queued = await waitForQueuedRetry(runId, "fan#i0");
    await cancelWorkflowRun(runId);

    startRetryPoller(registry, 10);
    await Bun.sleep(50);
    stopRetryPoller();
    await drainForeachDrives();
    expect((await getWorkflowRun(runId))!.status).toBe("cancelled");
    expect((await getWorkflowRunStep(queued.id))!.status).toBe("failed");
    expect(await getTaskByWorkflowRunStepId(queued.id)).toBeNull();
  });

  test("a sibling failing the run while the cut handler awaits records the cut", async () => {
    const runId = await startRun(2, {});
    const cut = await boundTask(runId, "fan#i0");
    const cutStep = (await stepByNodeId(runId, "fan#i0"))!;
    const sibling = await boundTask(runId, "fan#i1");
    const { workflowId } = (await getWorkflowRun(runId))!;

    // Hold the cut's task.failed handler at its getWorkflow read, after it
    // saw a live run, until the sibling's fail-fast has failed the run.
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const realGetWorkflow = db.getWorkflow;
    let held = false;
    const spy = spyOn(db, "getWorkflow").mockImplementation(async (id) => {
      const workflow = await realGetWorkflow(id);
      if (id === workflowId && !held) {
        held = true;
        reached();
        await gate;
      }
      return workflow;
    });
    try {
      await failTask(cut.id, SUPERSEDED_WORKFLOW_TASK_REASON);
      await paused;
      await failTask(sibling.id, "sibling crashed");
      await waitForRun(runId, (r) => r.status === "failed");
      release();

      const settled = await waitFor(async () => {
        const step = await stepByNodeId(runId, "fan#i0");
        return step?.status === "failed" && step.nextRetryAt == null ? step : null;
      }, "cut recorded as the item's outcome");
      expect(settled.error).toBe(SUPERSEDED_WORKFLOW_TASK_REASON);
      expect(settled.retryCount).toBe(0);
    } finally {
      release();
      spy.mockRestore();
    }

    startRetryPoller(registry, 10);
    await Bun.sleep(50);
    stopRetryPoller();
    await drainForeachDrives();
    const run = (await getWorkflowRun(runId))!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("sibling crashed");
    expect(await children(runId)).toHaveLength(2);

    await expectRunRetryStartsItemOnce(runId, cutStep.id, cut);
  });
});

/** `fan`, an agent-task foreach over the trigger items, then `after`. */
function fanOut(
  extra: Record<string, unknown>,
  retry?: Partial<NonNullable<WorkflowDefinition["nodes"][number]["retry"]>>,
): WorkflowDefinition {
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
        ...(retry
          ? {
              retry: { strategy: "static", baseDelayMs: 0, maxDelayMs: 0, maxRetries: 1, ...retry },
            }
          : {}),
        next: "after",
      },
      { id: "after", type: "notify", config: { channel: "swarm", template: "done" } },
    ],
  };
}

async function startRun(
  count: number,
  extra: Record<string, unknown>,
  retry?: Partial<NonNullable<WorkflowDefinition["nodes"][number]["retry"]>>,
): Promise<string> {
  const workflow = await createWorkflow({
    name: `foreach-supersede-${crypto.randomUUID()}`,
    definition: fanOut(extra, retry),
  });
  const items = Array.from({ length: count }, (_, index) => ({ id: `i${index}` }));
  const runId = await startWorkflowExecution(workflow, { items }, registry);
  await drainForeachDrives();
  return runId;
}

/** `fanOut` over two items, next to an independent `other` agent-task branch. */
async function startParallelRun(): Promise<string> {
  const definition = fanOut({});
  definition.nodes.push({
    id: "other",
    type: "agent-task",
    config: { agentId, template: "other" },
  });
  const workflow = await createWorkflow({
    name: `foreach-supersede-parallel-${crypto.randomUUID()}`,
    definition,
  });
  const runId = await startWorkflowExecution(
    workflow,
    { items: [{ id: "i0" }, { id: "i1" }] },
    registry,
  );
  await drainForeachDrives();
  return runId;
}

/**
 * Retry the failed run and give the poller time to act: `fan#i0` gets exactly
 * one new attempt with one fresh task, and the earlier row stays failed.
 */
async function expectRunRetryStartsItemOnce(
  runId: string,
  earlierStepId: string,
  cut: AgentTask,
): Promise<void> {
  await retryFailedRun(runId, registry);
  await drainForeachDrives();
  startRetryPoller(registry, 10);
  await Bun.sleep(50);
  stopRetryPoller();
  await drainForeachDrives();

  const attempts = (await children(runId)).filter((step) => step.nodeId === "fan#i0");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.id).toBe(earlierStepId);
  expect(attempts[0]!.status).toBe("failed");
  expect(attempts[0]!.nextRetryAt).toBeFalsy();
  const fresh = await boundTask(runId, "fan#i0");
  expect(fresh.id).not.toBe(cut.id);
  const bound = await db
    .getDbClient()
    .query<{ id: string }>("SELECT id FROM agent_tasks WHERE workflowRunStepId = ?", [
      attempts[1]!.id,
    ]);
  expect(bound).toHaveLength(1);
}

async function children(runId: string): Promise<WorkflowRunStep[]> {
  return (await getWorkflowRunStepsByRunId(runId)).filter((step) => step.nodeId.startsWith("fan#"));
}

async function stepByNodeId(runId: string, nodeId: string): Promise<WorkflowRunStep | undefined> {
  const steps = await getWorkflowRunStepsByRunId(runId);
  return steps.filter((step) => step.nodeId === nodeId).at(-1);
}

async function boundTask(runId: string, nodeId: string): Promise<AgentTask> {
  return waitFor(async () => {
    const step = await stepByNodeId(runId, nodeId);
    return step ? getTaskByWorkflowRunStepId(step.id) : null;
  }, `task bound to ${nodeId}`);
}

/** Wait for the item to be queued for the poller, then make it due now. */
async function waitForQueuedRetry(runId: string, nodeId: string): Promise<WorkflowRunStep> {
  const queued = await waitFor(async () => {
    const step = await stepByNodeId(runId, nodeId);
    return step?.status === "failed" && step.nextRetryAt != null ? step : null;
  }, `${nodeId} queued for retry`);
  await updateWorkflowRunStep(queued.id, { nextRetryAt: new Date(Date.now() - 1).toISOString() });
  return queued;
}

/** Run the poller until a fresh task is bound to the item and it waits on it. */
async function redrive(runId: string, nodeId: string, previous: AgentTask): Promise<AgentTask> {
  startRetryPoller(registry, 10);
  try {
    const task = await waitFor(async () => {
      const step = await stepByNodeId(runId, nodeId);
      if (step?.status !== "waiting") return null;
      const bound = await getTaskByWorkflowRunStepId(step.id);
      return bound && bound.id !== previous.id ? bound : null;
    }, `${nodeId} re-dispatched`);
    expect(task.status).not.toBe("failed");
    return task;
  } finally {
    stopRetryPoller();
    await drainForeachDrives();
  }
}

async function waitForStep(
  runId: string,
  nodeId: string,
  status: string,
): Promise<WorkflowRunStep> {
  return waitFor(async () => {
    const step = await stepByNodeId(runId, nodeId);
    return step?.status === status ? step : null;
  }, `${nodeId} ${status}`);
}

async function waitForRun(
  runId: string,
  done: (run: WorkflowRun) => boolean,
): Promise<WorkflowRun> {
  return waitFor(async () => {
    await drainForeachDrives();
    const run = await getWorkflowRun(runId);
    return run && done(run) ? run : null;
  }, `run ${runId}`);
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}
