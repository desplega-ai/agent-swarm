import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import {
  _resetWaitBusSubscriptionsForTests,
  initWaitBusSubscriptions,
  resumeWaitState,
} from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-wait-event.sqlite";

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

// ─── Helpers ───────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("WaitExecutor — event mode end-to-end", () => {
  test("event-mode wait persists, fires on bus event, advances run via 'event' port", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: {
            mode: "event",
            eventName: "demo.signal",
            filter: { ok: true },
          },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "got it" } },
      ],
    };
    const wf = makeWorkflow("wait-event-happy", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    // Run + step both 'waiting'.
    expect(getWorkflowRun(runId)?.status).toBe("waiting");
    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");
    expect(w1?.status).toBe("waiting");

    const waitState = getWaitStateByStepId(w1!.id);
    expect(waitState).not.toBeNull();
    expect(waitState?.mode).toBe("event");
    expect(waitState?.eventName).toBe("demo.signal");
    expect(waitState?.eventScope).toBe("run");
    expect(waitState?.status).toBe("pending");

    // The subscribeWaitToBus call inside execute already wired the listener.
    // Initialize busRegistry so processBusEvent can resume.
    initWaitBusSubscriptions(registry);

    // Fire matching signal — must include _runId for run-scope filter.
    workflowEventBus.emit("demo.signal", { ok: true, _runId: runId });

    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");

    const fired = getWaitStateByStepId(w1!.id);
    expect(fired?.status).toBe("fired");
    expect((fired?.firedPayload as { ok?: boolean })?.ok).toBe(true);

    const finalSteps = getWorkflowRunStepsByRunId(runId);
    const w1After = finalSteps.find((s) => s.nodeId === "w1");
    expect(w1After?.status).toBe("completed");
    expect(w1After?.nextPort).toBe("event");

    const doneStep = finalSteps.find((s) => s.nodeId === "done");
    expect(doneStep?.status).toBe("completed");
  });

  test("scope='run': mismatched _runId payload does NOT resolve the wait", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "event", eventName: "scoped.signal", scope: "run" },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "ok" } },
      ],
    };
    const wf = makeWorkflow("wait-event-scope-run", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");

    // Wrong _runId — must NOT match.
    workflowEventBus.emit("scoped.signal", { _runId: "nope-other-run-id" });
    // Yield once to let listeners fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("pending");

    // Right _runId — should match.
    workflowEventBus.emit("scoped.signal", { _runId: runId });
    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("fired");
  });

  test("scope='global': payload does not need _runId", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "event", eventName: "broadcast.signal", scope: "global" },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "ok" } },
      ],
    };
    const wf = makeWorkflow("wait-event-scope-global", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");

    workflowEventBus.emit("broadcast.signal", { source: "external" });
    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("fired");
  });

  test("string-form filter: only matching predicate resolves", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: {
            mode: "event",
            eventName: "tagged.signal",
            scope: "global",
            filter: "(p) => p.labels && p.labels.includes('release')",
          },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "ok" } },
      ],
    };
    const wf = makeWorkflow("wait-event-string-filter", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");

    // Non-matching payload → still pending.
    workflowEventBus.emit("tagged.signal", { labels: ["bug"] });
    await new Promise((r) => setTimeout(r, 50));
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("pending");

    // Matching payload.
    workflowEventBus.emit("tagged.signal", { labels: ["bug", "release"] });
    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("fired");
  });

  test("event-mode timeout routes via 'timeout' port (poller path)", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: {
            mode: "event",
            eventName: "never.fires",
            scope: "global",
            timeoutMs: 1000,
          },
          next: { event: "yes", timeout: "no" },
        },
        { id: "yes", type: "notify", config: { channel: "swarm", template: "fired" } },
        { id: "no", type: "notify", config: { channel: "swarm", template: "timed out" } },
      ],
    };
    const wf = makeWorkflow("wait-event-timeout", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");
    const ws = getWaitStateByStepId(w1!.id);
    expect(ws?.expiresAt).not.toBeNull();

    // Skip the 5s poller — fast-forward by directly calling the resume helper
    // with status='timeout' (the poller would do exactly this once expiresAt
    // passes).
    await new Promise((r) => setTimeout(r, 1100));
    const due = getDueWaitStates();
    expect(due.find((d) => d.id === ws!.id)).toBeDefined();

    await resumeWaitState(ws!.id, "timeout", undefined, registry);

    const after = getWaitStateByStepId(w1!.id);
    expect(after?.status).toBe("timeout");

    const finalSteps = getWorkflowRunStepsByRunId(runId);
    const w1After = finalSteps.find((s) => s.nodeId === "w1");
    expect(w1After?.status).toBe("completed");
    expect(w1After?.nextPort).toBe("timeout");

    const noStep = finalSteps.find((s) => s.nodeId === "no");
    expect(noStep?.status).toBe("completed");
  });

  test("fan-out: a single bus event resolves N concurrent waits subscribed to the same name", async () => {
    const registry = createExecutorRegistry(deps);

    const makeFanoutWorkflow = (id: string) => {
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "w1",
            type: "wait",
            config: { mode: "event", eventName: "fanout.signal", scope: "global" },
            next: { event: "done" },
          },
          { id: "done", type: "notify", config: { channel: "swarm", template: id } },
        ],
      };
      return makeWorkflow(`wait-fanout-${id}`, def);
    };

    // Two concurrent runs, each waiting on the SAME eventName. Both must be
    // registered with the bus before we emit (subscribeWaitToBus is called
    // inside WaitExecutor.execute, but initWaitBusSubscriptions wires the
    // resume side of the bridge — call it once after both runs are paused).
    const wfA = makeFanoutWorkflow("A");
    const wfB = makeFanoutWorkflow("B");
    const runIdA = await startWorkflowExecution(wfA, {}, registry);
    const runIdB = await startWorkflowExecution(wfB, {}, registry);

    expect(getWorkflowRun(runIdA)?.status).toBe("waiting");
    expect(getWorkflowRun(runIdB)?.status).toBe("waiting");

    const stepsA = getWorkflowRunStepsByRunId(runIdA);
    const stepsB = getWorkflowRunStepsByRunId(runIdB);
    const w1A = stepsA.find((s) => s.nodeId === "w1");
    const w1B = stepsB.find((s) => s.nodeId === "w1");

    initWaitBusSubscriptions(registry);

    // Single emit — both waits should resolve.
    workflowEventBus.emit("fanout.signal", { broadcast: true, sequence: 42 });

    await waitFor(
      () =>
        getWaitStateByStepId(w1A!.id)?.status === "fired" &&
        getWaitStateByStepId(w1B!.id)?.status === "fired",
      2000,
    );

    // Both wait_states flipped to fired with firedPayload populated.
    for (const stepId of [w1A!.id, w1B!.id]) {
      const fired = getWaitStateByStepId(stepId);
      expect(fired?.status).toBe("fired");
      const payload = fired?.firedPayload as { broadcast?: boolean; sequence?: number };
      expect(payload?.broadcast).toBe(true);
      expect(payload?.sequence).toBe(42);
      expect(fired?.resolvedAt).toBeTruthy();
    }

    // Both runs advanced via the `event` port and the downstream notify ran.
    for (const runId of [runIdA, runIdB]) {
      const finalSteps = getWorkflowRunStepsByRunId(runId);
      const w1After = finalSteps.find((s) => s.nodeId === "w1");
      expect(w1After?.status).toBe("completed");
      expect(w1After?.nextPort).toBe("event");
      const doneStep = finalSteps.find((s) => s.nodeId === "done");
      expect(doneStep?.status).toBe("completed");
    }
  });

  test("64KB cap: oversized payload is replaced with a truncation marker", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "event", eventName: "big.signal", scope: "global" },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "ok" } },
      ],
    };
    const wf = makeWorkflow("wait-event-cap", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");

    // 100KB payload — should trigger the 64KB cap.
    const huge = { blob: "x".repeat(100_000) };
    workflowEventBus.emit("big.signal", huge);

    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");

    const fired = getWaitStateByStepId(w1!.id);
    const stored = fired?.firedPayload as { truncated?: boolean; originalSize?: number };
    expect(stored?.truncated).toBe(true);
    expect(stored?.originalSize).toBeGreaterThan(64 * 1024);
  });
});
