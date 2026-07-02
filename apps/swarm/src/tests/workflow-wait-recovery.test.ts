import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  closeDb,
  createWaitState,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  deleteWorkflow,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { InProcessEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";

const TEST_DB_PATH = "./test-workflow-wait-recovery.sqlite";

const eventBus = new InProcessEventBus();
const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus,
  interpolate: (t: string) => t,
};

const createdWorkflowIds: string[] = [];

function makeWorkflow(name: string, def: WorkflowDefinition): Workflow {
  const wf = createWorkflow({ name: `${name}-${Date.now()}-${Math.random()}`, definition: def });
  createdWorkflowIds.push(wf.id);
  return wf;
}

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // ignore
  }
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  for (const id of createdWorkflowIds) {
    try {
      deleteWorkflow(id);
    } catch {
      // already deleted
    }
  }
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

describe("WaitExecutor — recovery on startup", () => {
  test("server died while waiting: overdue time-mode wait recovers via 'default' port", async () => {
    const registry = createExecutorRegistry(deps);

    // 1. Set up a workflow with a wait + downstream notify node, but build
    // the run/step state manually to simulate "server crashed mid-wait":
    // run 'waiting', step 'waiting', wait_state pending with wakeUpAt in
    // the past.
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "time", durationMs: 60_000 },
          next: { default: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "recovered" } },
      ],
    };
    const wf = makeWorkflow("wait-recovery-overdue", def);

    const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    updateWorkflowRun(run.id, { status: "waiting" });

    const step = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w1",
      nodeType: "wait",
    });
    updateWorkflowRunStep(step.id, { status: "waiting" });

    createWaitState({
      id: crypto.randomUUID(),
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "time",
      wakeUpAt: new Date(Date.now() - 60_000).toISOString(), // 1 min in the past
    });

    // Sanity: run is paused, wait is pending overdue.
    expect(getWorkflowRun(run.id)?.status).toBe("waiting");
    expect(getWaitStateByStepId(step.id)?.status).toBe("pending");

    // 2. Run recovery — must resume the wait and walk to 'done'.
    await recoverIncompleteRuns(registry);

    // 3. Assertions: wait fired, wait step completed via 'default' port,
    // notify step ran, run completed.
    const recoveredWait = getWaitStateByStepId(step.id);
    expect(recoveredWait?.status).toBe("fired");
    expect(recoveredWait?.resolvedAt).not.toBeNull();

    const recoveredStep = getWorkflowRunStep(step.id);
    expect(recoveredStep?.status).toBe("completed");
    expect(recoveredStep?.nextPort).toBe("default");

    const recoveredRun = getWorkflowRun(run.id);
    expect(recoveredRun?.status).toBe("completed");

    const allSteps = getWorkflowRunStepsByRunId(run.id);
    const doneStep = allSteps.find((s) => s.nodeId === "done");
    expect(doneStep?.status).toBe("completed");
  });

  test("recovery is idempotent: a second pass does not double-advance", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "time", durationMs: 60_000 },
          next: { default: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "recovered" } },
      ],
    };
    const wf = makeWorkflow("wait-recovery-idempotent", def);
    const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    updateWorkflowRun(run.id, { status: "waiting" });

    const step = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w1",
      nodeType: "wait",
    });
    updateWorkflowRunStep(step.id, { status: "waiting" });

    createWaitState({
      id: crypto.randomUUID(),
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "time",
      wakeUpAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await recoverIncompleteRuns(registry);
    const stepsAfter1 = getWorkflowRunStepsByRunId(run.id);
    expect(getWorkflowRun(run.id)?.status).toBe("completed");
    const doneCount1 = stepsAfter1.filter((s) => s.nodeId === "done").length;
    expect(doneCount1).toBe(1);

    // Second recovery pass — wait_state is now 'fired' (case a in the
    // recovery query). resumeWaitState's atomic update returns updated=false,
    // so the step shouldn't re-run.
    await recoverIncompleteRuns(registry);
    const stepsAfter2 = getWorkflowRunStepsByRunId(run.id);
    expect(stepsAfter2.filter((s) => s.nodeId === "done").length).toBe(1);
    expect(getWorkflowRun(run.id)?.status).toBe("completed");
  });
});
