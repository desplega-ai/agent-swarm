import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
  resolveWaitState,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { InProcessEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";

const TEST_DB_PATH = "./test-workflow-wait-recovery.sqlite";
const templateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};
let savedTemplate: Uint8Array | undefined;

const eventBus = new InProcessEventBus();
const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus,
  interpolate: (t: string) => t,
};

const createdWorkflowIds: string[] = [];

async function makeWorkflow(name: string, def: WorkflowDefinition): Promise<Workflow> {
  const wf = await createWorkflow({
    name: `${name}-${Date.now()}-${Math.random()}`,
    definition: def,
  });
  createdWorkflowIds.push(wf.id);
  return wf;
}

async function makeResolvedWait(
  mode: "time" | "event",
  status: "fired" | "timeout",
  nextPort: string,
) {
  const wf = await makeWorkflow("wait-recovery-resolved", {
    nodes: [
      {
        id: "w1",
        type: "wait",
        config:
          mode === "time"
            ? { mode, durationMs: 60_000 }
            : { mode, eventName: "saved.signal", timeoutMs: 60_000 },
        next: { [nextPort]: "done" },
      },
      { id: "done", type: "notify", config: { channel: "swarm", template: "recovered" } },
    ],
  });
  const run = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
  await updateWorkflowRun(run.id, { status: "waiting" });
  const step = await createWorkflowRunStep({
    id: crypto.randomUUID(),
    runId: run.id,
    nodeId: "w1",
    nodeType: "wait",
  });
  await updateWorkflowRunStep(step.id, { status: "waiting" });
  const future = new Date(Date.now() + 60_000).toISOString();
  const wait = await createWaitState({
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    workflowRunStepId: step.id,
    mode,
    ...(mode === "time" ? { wakeUpAt: future } : { eventName: "saved.signal", expiresAt: future }),
  });
  const payload = mode === "event" && status === "fired" ? { signal: "saved", ok: true } : null;
  const resolution = await resolveWaitState(wait.id, { status, firedPayload: payload });
  expect(resolution.updated).toBe(true);
  return { run, step, wait, payload, resolution };
}

beforeAll(async () => {
  // Use a file-backed DB so restart cases retain their committed wait resolutions.
  savedTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
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
      await deleteWorkflow(id);
    } catch {
      // already deleted
    }
  }
  closeDb();
  templateGlobals.__testMigrationTemplate = savedTemplate;
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

describe("WaitExecutor — recovery on startup", () => {
  test.each([
    ["time", "fired", "default"],
    ["event", "fired", "event"],
    ["event", "timeout", "timeout"],
  ] as const)("recovers a persisted %s/%s resolution after restart via '%s' exactly once", async (mode, status, nextPort) => {
    const registry = createExecutorRegistry(deps);
    const { run, step, wait, payload, resolution } = await makeResolvedWait(mode, status, nextPort);

    // Reopen after the resolution commits, before the waiting step is checkpointed.
    closeDb();
    initDb(TEST_DB_PATH);
    expect((await getWorkflowRunStep(step.id))?.status).toBe("waiting");
    expect((await getWaitStateByStepId(step.id))?.status).toBe(status);
    await Promise.all([recoverIncompleteRuns(registry), recoverIncompleteRuns(registry)]);

    const recoveredStep = await getWorkflowRunStep(step.id);
    expect(recoveredStep?.status).toBe("completed");
    expect(recoveredStep?.nextPort).toBe(nextPort);
    expect(recoveredStep?.output).toEqual({
      waitId: wait.id,
      mode,
      firedAt: resolution.row!.resolvedAt,
      payload,
    });
    expect(await getWaitStateByStepId(step.id)).toEqual(resolution.row);
    expect((await getWorkflowRun(run.id))?.status).toBe("completed");
    const doneSteps = (await getWorkflowRunStepsByRunId(run.id)).filter((s) => s.nodeId === "done");
    expect(doneSteps).toHaveLength(1);
    expect(doneSteps[0]?.status).toBe("completed");

    await recoverIncompleteRuns(registry);
    expect((await getWorkflowRunStepsByRunId(run.id)).filter((s) => s.nodeId === "done")).toEqual(
      doneSteps,
    );
    expect((await getWorkflowRun(run.id))?.status).toBe("completed");
  });

  test.each([
    "completed",
    "failed",
    "cancelled",
  ] as const)("does not reopen a %s run that becomes terminal during wait recovery", async (status) => {
    const registry = createExecutorRegistry(deps);
    const { run, step } = await makeResolvedWait("event", "fired", "event");
    const getWorkflow = db.getWorkflow;
    const snapshot = spyOn(db, "getWorkflow").mockImplementationOnce(async (id) => {
      const workflow = await getWorkflow(id);
      expect((await getWorkflowRun(run.id))?.status).toBe("waiting");
      // A sibling can fail the run after the resume read, leaving this step waiting.
      await updateWorkflowRun(run.id, { status });
      return workflow;
    });
    try {
      await recoverIncompleteRuns(registry);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect((await getWorkflowRun(run.id))?.status).toBe(status);
      expect((await getWorkflowRunStep(step.id))?.status).toBe("waiting");
      expect(await getWorkflowRunStepsByRunId(run.id)).toHaveLength(1);
    } finally {
      snapshot.mockRestore();
    }
  });

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
    const wf = await makeWorkflow("wait-recovery-overdue", def);

    const run = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    await updateWorkflowRun(run.id, { status: "waiting" });

    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w1",
      nodeType: "wait",
    });
    await updateWorkflowRunStep(step.id, { status: "waiting" });

    await createWaitState({
      id: crypto.randomUUID(),
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "time",
      wakeUpAt: new Date(Date.now() - 60_000).toISOString(), // 1 min in the past
    });

    // Sanity: run is paused, wait is pending overdue.
    expect((await getWorkflowRun(run.id))?.status).toBe("waiting");
    expect((await getWaitStateByStepId(step.id))?.status).toBe("pending");

    // 2. Run recovery — must resume the wait and walk to 'done'.
    await recoverIncompleteRuns(registry);

    // 3. Assertions: wait fired, wait step completed via 'default' port,
    // notify step ran, run completed.
    const recoveredWait = await getWaitStateByStepId(step.id);
    expect(recoveredWait?.status).toBe("fired");
    expect(recoveredWait?.resolvedAt).not.toBeNull();

    const recoveredStep = await getWorkflowRunStep(step.id);
    expect(recoveredStep?.status).toBe("completed");
    expect(recoveredStep?.nextPort).toBe("default");

    const recoveredRun = await getWorkflowRun(run.id);
    expect(recoveredRun?.status).toBe("completed");

    const allSteps = await getWorkflowRunStepsByRunId(run.id);
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
    const wf = await makeWorkflow("wait-recovery-idempotent", def);
    const run = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    await updateWorkflowRun(run.id, { status: "waiting" });

    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w1",
      nodeType: "wait",
    });
    await updateWorkflowRunStep(step.id, { status: "waiting" });

    await createWaitState({
      id: crypto.randomUUID(),
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "time",
      wakeUpAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await recoverIncompleteRuns(registry);
    const stepsAfter1 = await getWorkflowRunStepsByRunId(run.id);
    expect((await getWorkflowRun(run.id))?.status).toBe("completed");
    const doneCount1 = stepsAfter1.filter((s) => s.nodeId === "done").length;
    expect(doneCount1).toBe(1);

    // Completed runs and steps are no longer eligible for recovery.
    await recoverIncompleteRuns(registry);
    const stepsAfter2 = await getWorkflowRunStepsByRunId(run.id);
    expect(stepsAfter2.filter((s) => s.nodeId === "done").length).toBe(1);
    expect((await getWorkflowRun(run.id))?.status).toBe("completed");
  });
});
