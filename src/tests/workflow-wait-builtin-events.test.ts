/**
 * Phase 4 verification: a `wait` node correlates against an existing
 * built-in `workflowEventBus` event (`task.completed`) without any new
 * emit code in production.
 *
 * Why a fan-out shape (entry → [agent-task, wait])?
 * --------------------------------------------------
 * Linear `agent-task → wait { eventName: "task.completed" }` does NOT work —
 * by the time execution reaches the wait, the upstream's `task.completed`
 * has already fired and the bus event is gone. The wait must subscribe
 * BEFORE the event fires, so it has to register on a parallel branch.
 *
 * What this test simulates
 * ------------------------
 * Spinning up a real agent-task involves provider work (Claude / Codex /
 * etc.) which is too heavy for a unit test. Instead we exercise the same
 * code path the real emit hits by emitting `task.completed` directly via
 * `workflowEventBus.emit` with a payload shaped exactly like the one
 * produced from `src/be/db.ts` (`{ taskId, output, agentId, workflowRunId,
 * workflowRunStepId }`). This proves the wait correlates against the
 * built-in event by `workflowRunId` filter — no production-code changes
 * outside of Phases 1–3.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  deleteWorkflow,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { _resetWaitBusSubscriptionsForTests, initWaitBusSubscriptions } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-wait-builtin-events.sqlite";

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
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
    } catch {}
  }
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

afterEach(() => {
  _resetWaitBusSubscriptionsForTests();
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("WaitExecutor — built-in bus events (Phase 4 verification)", () => {
  test("wait correlates against task.completed via workflowRunId filter (fan-out)", async () => {
    const registry = createExecutorRegistry(deps);

    // Fan-out shape: a script entry node spawns two parallel branches.
    // Branch A is a placeholder for the agent-task that would fire
    // task.completed. Branch B is the wait node, which subscribes to
    // `task.completed` BEFORE the simulated emit happens. After the wait
    // resolves it falls through to a terminal `notify` node.
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "entry",
          type: "script",
          config: { runtime: "bash", script: "echo go" },
          next: ["w1", "tail"],
        },
        {
          id: "w1",
          type: "wait",
          config: {
            mode: "event",
            eventName: "task.completed",
            // Built-in task.completed payload includes `workflowRunId` —
            // we filter on it to correlate against this specific run.
            // The matcher walks the dot-path, so this maps to
            // payload.workflowRunId === <captured run id>.
            // We can't interpolate {{trigger.runId}} here without an
            // explicit `inputs` mapping, so the test rebuilds the def
            // after `runId` is known and re-creates the workflow.
            // For simplicity we use scope='run' which already enforces
            // workflowRunId === waitState.workflowRunId — that's the
            // canonical correlation path for built-in events.
            scope: "run",
          },
          next: { event: "tail" },
        },
        {
          id: "tail",
          type: "notify",
          config: { channel: "swarm", template: "done" },
        },
      ],
    };
    const wf = makeWorkflow("wait-builtin-task-completed", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    // Initialize the bus listener registry (parity with initWorkflows()).
    initWaitBusSubscriptions(registry);

    // The wait should be in 'waiting' status at this point — it registered
    // its bus subscription during execute. The fan-out's other branch may
    // already have run.
    expect(getWorkflowRun(runId)?.status).toBe("waiting");
    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");
    expect(w1?.status).toBe("waiting");

    const waitState = getWaitStateByStepId(w1!.id);
    expect(waitState).not.toBeNull();
    expect(waitState?.eventName).toBe("task.completed");

    // Simulate the agent-task completing. The payload is exactly what
    // `completeTask` in src/be/db.ts emits today — including
    // workflowRunId, which the scope='run' matcher uses to correlate.
    workflowEventBus.emit("task.completed", {
      taskId: "fake-task-id-1",
      output: '{"result":"ok"}',
      agentId: "fake-agent-id",
      workflowRunId: runId,
      workflowRunStepId: "fake-step-id-on-some-other-run",
    });

    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");

    const fired = getWaitStateByStepId(w1!.id);
    expect(fired?.status).toBe("fired");
    const stored = fired?.firedPayload as { workflowRunId?: string; output?: string };
    expect(stored?.workflowRunId).toBe(runId);

    // The wait advanced via `event` port — the run should reach the tail.
    const finalSteps = getWorkflowRunStepsByRunId(runId);
    const w1After = finalSteps.find((s) => s.nodeId === "w1");
    expect(w1After?.status).toBe("completed");
    expect(w1After?.nextPort).toBe("event");

    // tail should run (could be once or twice depending on convergence —
    // we just assert it completed at least once).
    const tailSteps = finalSteps.filter((s) => s.nodeId === "tail");
    expect(tailSteps.length).toBeGreaterThanOrEqual(1);
    expect(tailSteps.every((s) => s.status === "completed")).toBe(true);
  });

  test("scope='run' rejects task.completed from a different run", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "entry",
          type: "script",
          config: { runtime: "bash", script: "echo go" },
          next: ["w1", "tail"],
        },
        {
          id: "w1",
          type: "wait",
          config: { mode: "event", eventName: "task.completed", scope: "run" },
          next: { event: "tail" },
        },
        { id: "tail", type: "notify", config: { channel: "swarm", template: "done" } },
      ],
    };
    const wf = makeWorkflow("wait-builtin-task-completed-other-run", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");

    // Emit a task.completed bound to a DIFFERENT run — must NOT resolve
    // this wait because scope='run' enforces workflowRunId === this runId.
    workflowEventBus.emit("task.completed", {
      taskId: "task-from-elsewhere",
      output: "ignored",
      agentId: "x",
      workflowRunId: "some-other-run-id-not-ours",
      workflowRunStepId: "some-other-step",
    });

    // Yield to listeners.
    await new Promise((r) => setTimeout(r, 50));
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("pending");

    // Now emit one bound to OUR run — should resolve.
    workflowEventBus.emit("task.completed", {
      taskId: "task-for-us",
      output: "ok",
      agentId: "x",
      workflowRunId: runId,
      workflowRunStepId: "any-step",
    });
    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("fired");
  });

  test("create-workflow accepts a wait-node-containing definition (Zod round-trip)", () => {
    // Validation is purely Zod-driven via WorkflowDefinitionSchema. Wait
    // node config is a `z.record` at the schema level; the WaitExecutor's
    // own configSchema parses it at execution time. Here we just round-trip
    // a definition with both time- and event-mode wait nodes through the
    // public `createWorkflow` path to prove the schema accepts them.
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "time-wait",
          type: "wait",
          config: { mode: "time", durationMs: 30000 },
          next: { default: "event-wait" },
        },
        {
          id: "event-wait",
          type: "wait",
          config: {
            mode: "event",
            eventName: "demo.signal",
            filter: { ok: true },
            scope: "run",
            timeoutMs: 60_000,
          },
          next: { event: "yay", timeout: "nay" },
        },
        { id: "yay", type: "notify", config: { channel: "swarm", template: "ok" } },
        { id: "nay", type: "notify", config: { channel: "swarm", template: "timed out" } },
      ],
    };
    const wf = makeWorkflow("wait-roundtrip", def);
    expect(wf.id).toBeTruthy();
    expect(wf.definition.nodes).toHaveLength(4);
    const timeWait = wf.definition.nodes.find((n) => n.id === "time-wait");
    expect(timeWait?.type).toBe("wait");
    expect((timeWait?.config as { mode?: string })?.mode).toBe("time");
    const eventWait = wf.definition.nodes.find((n) => n.id === "event-wait");
    expect((eventWait?.config as { mode?: string })?.mode).toBe("event");
    expect((eventWait?.config as { timeoutMs?: number })?.timeoutMs).toBe(60_000);
  });
});
