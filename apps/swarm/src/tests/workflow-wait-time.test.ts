import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  deleteWorkflow,
  getDueWaitStates,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { resumeWaitState } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-wait-time.sqlite";

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

describe("WaitExecutor — time mode end-to-end", () => {
  test("workflow with a time-wait node pauses, then resumes via the poll path", async () => {
    const registry = createExecutorRegistry(deps);

    // Tiny duration so the wait_state is overdue immediately. We don't rely
    // on the 5s wait poller in the test — instead we drive the resume path
    // directly via the same code path the poller would call.
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "time", durationMs: 50 },
          next: { default: "done" },
        },
        {
          id: "done",
          type: "notify",
          config: { channel: "swarm", template: "wait finished" },
        },
      ],
    };
    const wf = makeWorkflow("wait-time-end-to-end", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    // Wait should be paused — run + step both 'waiting'.
    const run = getWorkflowRun(runId);
    expect(run?.status).toBe("waiting");
    const steps = getWorkflowRunStepsByRunId(runId);
    const w1Step = steps.find((s) => s.nodeId === "w1");
    expect(w1Step?.status).toBe("waiting");
    expect(w1Step?.nodeType).toBe("wait"); // recovery query uses this

    // The wait_state row exists and is pending.
    const waitState = getWaitStateByStepId(w1Step!.id);
    expect(waitState).not.toBeNull();
    expect(waitState?.status).toBe("pending");
    expect(waitState?.mode).toBe("time");

    // Wait long enough that wakeUpAt is in the past, then drive the same
    // resume path the poller would use.
    await new Promise((r) => setTimeout(r, 80));

    const due = getDueWaitStates();
    expect(due.find((d) => d.id === waitState!.id)).toBeDefined();

    await resumeWaitState(waitState!.id, "fired", undefined, registry);

    // After resume: wait_state fired, step completed via 'default' port,
    // notify ran, run completed.
    const afterWait = getWaitStateByStepId(w1Step!.id);
    expect(afterWait?.status).toBe("fired");
    expect(afterWait?.resolvedAt).not.toBeNull();

    const afterRun = getWorkflowRun(runId);
    expect(afterRun?.status).toBe("completed");

    const afterSteps = getWorkflowRunStepsByRunId(runId);
    const w1After = afterSteps.find((s) => s.nodeId === "w1");
    expect(w1After?.status).toBe("completed");
    expect(w1After?.nextPort).toBe("default");

    const doneStep = afterSteps.find((s) => s.nodeId === "done");
    expect(doneStep?.status).toBe("completed");
  });

  test("idempotency: double-resume is a no-op (race-safe)", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "time", durationMs: 30 },
          next: { default: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "ok" } },
      ],
    };
    const wf = makeWorkflow("wait-time-idempotent", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1Step = steps.find((s) => s.nodeId === "w1");
    const waitState = getWaitStateByStepId(w1Step!.id);

    await new Promise((r) => setTimeout(r, 50));

    // First resume — should advance the run.
    await resumeWaitState(waitState!.id, "fired", undefined, registry);
    let run = getWorkflowRun(runId);
    expect(run?.status).toBe("completed");

    // Second resume — must NOT throw, must NOT undo state.
    await resumeWaitState(waitState!.id, "fired", undefined, registry);
    run = getWorkflowRun(runId);
    expect(run?.status).toBe("completed");
  });

  test("re-execute on existing pending wait_state returns async marker (idempotent execute)", async () => {
    const registry = createExecutorRegistry(deps);
    const waitExecutor = registry.get("wait");

    // Simulate running execute twice with the same stepId without resolving
    // the wait. The second call should detect the existing pending row and
    // return the async marker rather than inserting a duplicate.
    const meta = {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "w1",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    };
    const config = { mode: "time", durationMs: 60_000 };

    const r1 = await waitExecutor.run({ config, context: {}, meta });
    expect(r1.status).toBe("success");
    expect((r1 as unknown as { async?: boolean }).async).toBe(true);

    const stateAfter1 = getWaitStateByStepId(meta.stepId);
    expect(stateAfter1).not.toBeNull();

    const r2 = await waitExecutor.run({ config, context: {}, meta });
    expect(r2.status).toBe("success");
    expect((r2 as unknown as { async?: boolean }).async).toBe(true);

    // Still exactly one wait_state row — second execute didn't insert.
    const stateAfter2 = getWaitStateByStepId(meta.stepId);
    expect(stateAfter2?.id).toBe(stateAfter1!.id);
  });

  test("config validation rejects mode='time' with durationMs <= 0", async () => {
    const registry = createExecutorRegistry(deps);
    const waitExecutor = registry.get("wait");
    const meta = {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "w1",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    };

    const result = await waitExecutor.run({
      config: { mode: "time", durationMs: 0 },
      context: {},
      meta,
    });
    expect(result.status).toBe("failed");
  });

  test("config validation rejects unknown mode", async () => {
    const registry = createExecutorRegistry(deps);
    const waitExecutor = registry.get("wait");
    const meta = {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "w1",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    };

    const result = await waitExecutor.run({
      config: { mode: "bogus", durationMs: 100 },
      context: {},
      meta,
    });
    expect(result.status).toBe("failed");
  });

  test("event-mode execute now wired (Phase 3) — returns async marker, persists wait_state", async () => {
    const registry = createExecutorRegistry(deps);
    const waitExecutor = registry.get("wait");
    const meta = {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "w1",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    };

    const result = await waitExecutor.run({
      config: { mode: "event", eventName: "demo.signal" },
      context: {},
      meta,
    });
    expect(result.status).toBe("success");
    expect((result as unknown as { async?: boolean }).async).toBe(true);

    const persisted = getWaitStateByStepId(meta.stepId);
    expect(persisted?.mode).toBe("event");
    expect(persisted?.eventName).toBe("demo.signal");
    expect(persisted?.eventScope).toBe("run");
  });
});
