import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  cancelTask,
  closeDb,
  completeTask,
  createWorkflow,
  failTask,
  getTaskById,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { AgentTask, WorkflowDefinition, WorkflowRunStep } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-agent-task-retry.sqlite";

class NotifyStubExecutor extends BaseExecutor<
  typeof NotifyStubExecutor.schema,
  typeof NotifyStubExecutor.outSchema
> {
  static readonly schema = z.object({ channel: z.string(), template: z.string() });
  static readonly outSchema = z.object({ sent: z.boolean() });

  readonly type = "notify";
  readonly mode = "instant" as const;
  readonly configSchema = NotifyStubExecutor.schema;
  readonly outputSchema = NotifyStubExecutor.outSchema;

  protected async execute(): Promise<ExecutorResult<z.infer<typeof NotifyStubExecutor.outSchema>>> {
    return { status: "success", output: { sent: true } };
  }
}

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (template, ctx) => interpolate(template, ctx).result,
};

let registry: ExecutorRegistry;
let teardownResumeListener: (() => void) | undefined;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  registry = new ExecutorRegistry();
  registry.register(new NotifyStubExecutor(deps));
  registry.register(new AgentTaskExecutor(deps));
  teardownResumeListener = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterEach(() => {
  stopRetryPoller();
});

afterAll(async () => {
  // Detach from the process-wide singleton bus (see setupWorkflowResumeListener).
  teardownResumeListener?.();
  stopRetryPoller();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

let counter = 0;

/** synthesize (agent-task) → done (notify); `retry` lands on the node itself. */
async function startRun(opts: {
  retry?: WorkflowDefinition["nodes"][number]["retry"];
  onNodeFailure?: "fail" | "continue";
}): Promise<string> {
  counter++;
  const workflow = await createWorkflow({
    name: `agent-task-retry-${counter}-${Date.now()}`,
    definition: {
      ...(opts.onNodeFailure ? { onNodeFailure: opts.onNodeFailure } : {}),
      nodes: [
        {
          id: "synthesize",
          type: "agent-task",
          config: { template: "Synthesize" },
          ...(opts.retry ? { retry: opts.retry } : {}),
          next: "done",
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "done" } },
      ],
    },
  });
  const runId = await startWorkflowExecution(workflow, {}, registry);
  expect((await getWorkflowRun(runId))!.status).toBe("waiting");
  return runId;
}

async function synthesizeStep(runId: string): Promise<WorkflowRunStep> {
  const steps = await getWorkflowRunStepsByRunId(runId);
  return steps.find((s) => s.nodeId === "synthesize")!;
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
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Wait until a task other than `previous` is bound to the step. */
async function waitForRedrive(stepId: string, previous: AgentTask): Promise<AgentTask> {
  return waitFor(async () => {
    const bound = await getTaskByWorkflowRunStepId(stepId);
    return bound && bound.id !== previous.id ? bound : null;
  }, "redriven task");
}

const RETRY_ONCE = { maxRetries: 1, strategy: "static" as const, baseDelayMs: 0, maxDelayMs: 0 };

describe("agent-task node.retry on task failure", () => {
  test("a superseded task with retry {maxRetries:1} is redriven once and the run continues", async () => {
    const runId = await startRun({ retry: RETRY_ONCE });
    const step = await synthesizeStep(runId);
    const first = (await getTaskByWorkflowRunStepId(step.id))!;

    await failTask(first.id, "superseded_workflow_task");

    // Queued for the poller: step failed with nextRetryAt, run not failed,
    // failed task detached so the executor creates a fresh one.
    const queued = await waitFor(async () => {
      const s = await synthesizeStep(runId);
      return s.status === "failed" && s.nextRetryAt != null ? s : null;
    }, "step queued for retry");
    expect(queued.retryCount).toBe(1);
    expect(queued.error).toBe("superseded_workflow_task");
    expect((await getWorkflowRun(runId))!.status).toBe("waiting");
    expect((await getTaskById(first.id))!.workflowRunStepId).toBeFalsy();

    startRetryPoller(registry, 10);
    const second = await waitForRedrive(step.id, first);
    expect(second.status).not.toBe("failed");
    const waiting = await waitFor(async () => {
      const s = await synthesizeStep(runId);
      return s.status === "waiting" ? s : null;
    }, "step waiting on redriven task");
    expect(waiting.id).toBe(step.id);
    stopRetryPoller();

    await completeTask(second.id, "synthesis done");
    const run = await waitFor(async () => {
      const r = await getWorkflowRun(runId);
      return r?.status === "completed" ? r : null;
    }, "run completed");
    expect(run.status).toBe("completed");
    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.filter((s) => s.nodeId === "synthesize")).toHaveLength(1);
    expect(steps.find((s) => s.nodeId === "done")?.status).toBe("completed");
  });

  test("a second failure exhausts retries and falls through to onNodeFailure", async () => {
    const runId = await startRun({ retry: RETRY_ONCE, onNodeFailure: "continue" });
    const step = await synthesizeStep(runId);
    const first = (await getTaskByWorkflowRunStepId(step.id))!;

    await failTask(first.id, "superseded_workflow_task");
    startRetryPoller(registry, 10);
    const second = await waitForRedrive(step.id, first);
    await waitFor(async () => {
      const s = await synthesizeStep(runId);
      return s.status === "waiting" ? s : null;
    }, "step waiting on redriven task");
    stopRetryPoller();

    // A late duplicate event for the FIRST task must not consume the retry
    // budget or touch the step now bound to the second task.
    workflowEventBus.emit("task.failed", {
      taskId: first.id,
      failureReason: "duplicate",
      workflowRunId: runId,
      workflowRunStepId: step.id,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await synthesizeStep(runId)).status).toBe("waiting");

    await failTask(second.id, "superseded_workflow_task");
    const run = await waitFor(async () => {
      const r = await getWorkflowRun(runId);
      return r?.status === "completed" ? r : null;
    }, "run completed via onNodeFailure:continue");
    expect(run.status).toBe("completed");
    const finalStep = await synthesizeStep(runId);
    expect(finalStep.status).toBe("completed");
    expect(finalStep.retryCount).toBe(1);
    expect(finalStep.nextRetryAt).toBeFalsy();
    expect(JSON.stringify(finalStep.output)).toContain("[FAILED:");
    // No third task was ever created.
    expect((await getTaskByWorkflowRunStepId(step.id))!.id).toBe(second.id);
  });

  test("a node without retry fails the run exactly as before", async () => {
    const runId = await startRun({});
    const step = await synthesizeStep(runId);
    const first = (await getTaskByWorkflowRunStepId(step.id))!;

    await failTask(first.id, "superseded_workflow_task");

    const run = await waitFor(async () => {
      const r = await getWorkflowRun(runId);
      return r?.status === "failed" ? r : null;
    }, "run failed");
    expect(run.error).toContain("superseded_workflow_task");
    const failedStep = await synthesizeStep(runId);
    expect(failedStep.status).toBe("failed");
    expect(failedStep.retryCount).toBe(0);
    expect(failedStep.nextRetryAt).toBeFalsy();
    expect((await getTaskByWorkflowRunStepId(step.id))!.id).toBe(first.id);
  });

  test("a cancelled task never retries, even with retry set", async () => {
    const runId = await startRun({ retry: RETRY_ONCE });
    const step = await synthesizeStep(runId);
    const first = (await getTaskByWorkflowRunStepId(step.id))!;

    await cancelTask(first.id, "operator cancel");

    const run = await waitFor(async () => {
      const r = await getWorkflowRun(runId);
      return r?.status === "failed" ? r : null;
    }, "run failed");
    expect(run.error).toContain("cancelled");
    const failedStep = await synthesizeStep(runId);
    expect(failedStep.retryCount).toBe(0);
    expect(failedStep.nextRetryAt).toBeFalsy();
    expect((await getTaskByWorkflowRunStepId(step.id))!.id).toBe(first.id);
  });

  test("the recovery sweep applies the same retry when it sees the failed task first", async () => {
    const runId = await startRun({ retry: RETRY_ONCE });
    const step = await synthesizeStep(runId);
    const first = (await getTaskByWorkflowRunStepId(step.id))!;

    // Detach the live listener so only the heartbeat sweep sees the failure.
    teardownResumeListener?.();
    try {
      await failTask(first.id, "superseded_workflow_task");
      await new Promise((r) => setTimeout(r, 20));
      await recoverIncompleteRuns(registry);
    } finally {
      teardownResumeListener = setupWorkflowResumeListener(workflowEventBus, registry);
    }

    const queued = await synthesizeStep(runId);
    expect(queued.status).toBe("failed");
    expect(queued.nextRetryAt).toBeTruthy();
    expect(queued.retryCount).toBe(1);
    expect((await getWorkflowRun(runId))!.status).toBe("waiting");

    startRetryPoller(registry, 10);
    const second = await waitForRedrive(step.id, first);
    expect(second.id).not.toBe(first.id);
  });
});

describe("recovery sweep holding a stale failed-task snapshot", () => {
  /**
   * Recovery snapshots task A as failed, then pauses. Meanwhile the live
   * task.failed handler queues A's retry and the poller binds task B to the
   * same step, back in `waiting`. When recovery resumes on its stale A row it
   * must leave the step bound to B alone.
   */
  async function raceStaleRecovery(maxRetries: number) {
    const runId = await startRun({ retry: { ...RETRY_ONCE, maxRetries } });
    const step = await synthesizeStep(runId);
    const first = (await getTaskByWorkflowRunStepId(step.id))!;

    let releaseSnapshot!: () => void;
    const snapshotHeld = new Promise<void>((r) => {
      releaseSnapshot = r;
    });
    let snapshotTaken!: () => void;
    const snapshotReady = new Promise<void>((r) => {
      snapshotTaken = r;
    });
    const realGetStuck = db.getStuckWorkflowRuns;
    const spy = spyOn(db, "getStuckWorkflowRuns").mockImplementation(async () => {
      const rows = await realGetStuck();
      snapshotTaken();
      await snapshotHeld;
      return rows;
    });

    let recovery: Promise<unknown> | undefined;
    try {
      // Fail A with the listener detached so the sweep's snapshot sees it.
      teardownResumeListener?.();
      try {
        await failTask(first.id, "superseded_workflow_task");
        recovery = recoverIncompleteRuns(registry);
        await snapshotReady;
      } finally {
        teardownResumeListener = setupWorkflowResumeListener(workflowEventBus, registry);
      }

      // The live event for A arrives late: retry queued, B dispatched.
      workflowEventBus.emit("task.failed", {
        taskId: first.id,
        failureReason: "superseded_workflow_task",
        workflowRunId: runId,
        workflowRunStepId: step.id,
      });
      startRetryPoller(registry, 10);
      const second = await waitForRedrive(step.id, first);
      await waitFor(async () => {
        const s = await synthesizeStep(runId);
        return s.status === "waiting" ? s : null;
      }, "step waiting on redriven task");
      stopRetryPoller();

      releaseSnapshot();
      await recovery;
      recovery = undefined;

      const after = await synthesizeStep(runId);
      expect(after.status).toBe("waiting");
      expect(after.retryCount).toBe(1);
      expect(after.nextRetryAt).toBeFalsy();
      expect((await getWorkflowRun(runId))!.status).toBe("waiting");
      expect((await getTaskByWorkflowRunStepId(step.id))!.id).toBe(second.id);
    } finally {
      releaseSnapshot();
      await recovery;
      spy.mockRestore();
    }
  }

  test("with retries left, the stale snapshot does not consume another retry", async () => {
    await raceStaleRecovery(3);
  });

  test("with retries exhausted, the stale snapshot does not route onNodeFailure", async () => {
    await raceStaleRecovery(1);
  });
});
