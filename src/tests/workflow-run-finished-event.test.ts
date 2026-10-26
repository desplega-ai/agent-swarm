/**
 * `workflow.run.finished`: every run, top-level or child, emits it once after
 * commit when it turns terminal, so an event-mode `wait` can resume when any
 * run ends.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { recordWorkflowPreflightFailure } from "../be/automation-preflight";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  updateWorkflowRun,
} from "../be/db";
import { cancelLiveWorkflowTreeRuns } from "../be/db/workflow-runs";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { _resetWaitBusSubscriptionsForTests, initWaitBusSubscriptions } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-run-finished-event.sqlite";
const EVENT = "workflow.run.finished";

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};

type FinishedPayload = { runId: string; workflowId: string; status: string };

const received: FinishedPayload[] = [];
const onFinished = (data: unknown) => received.push(data as FinishedPayload);

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  initDb(TEST_DB_PATH);
  workflowEventBus.on(EVENT, onFinished);
});

afterAll(async () => {
  workflowEventBus.off(EVENT, onFinished);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

afterEach(() => {
  _resetWaitBusSubscriptionsForTests();
});

async function makeWorkflow(name: string, def?: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({
    name: `${name}-${crypto.randomUUID()}`,
    definition: def ?? {
      nodes: [{ id: "n", type: "notify", config: { channel: "swarm", template: "x" } }],
    },
  });
}

async function newRun(workflowId: string): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRun({ id, workflowId });
  return id;
}

const eventsFor = (runId: string) => received.filter((event) => event.runId === runId);

// The emit goes through afterCommit and a dynamic import, so let it settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000) {
  const t0 = Date.now();
  while (!(await predicate())) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("workflow.run.finished", () => {
  test("fires once per terminal transition, with the run id as runId", async () => {
    const wf = await makeWorkflow("run-finished-once");
    const runId = await newRun(wf.id);

    await updateWorkflowRun(runId, { status: "waiting" });
    await settle();
    expect(eventsFor(runId)).toEqual([]);

    await updateWorkflowRun(runId, { status: "failed", error: "boom" });
    await waitFor(() => eventsFor(runId).length === 1);
    expect(eventsFor(runId)[0]).toEqual({ runId, workflowId: wf.id, status: "failed" });
    expect(eventsFor(runId)[0]).not.toHaveProperty("workflowRunId");
    expect(eventsFor(runId)[0]).not.toHaveProperty("_runId");

    // Later writes to the terminal run, with or without the same status, stay silent.
    await updateWorkflowRun(runId, { context: { late: true } });
    await updateWorkflowRun(runId, { status: "failed", error: "boom again" });
    await settle();
    expect(eventsFor(runId)).toHaveLength(1);

    // A retry reopens the run; its next end is a new transition.
    await updateWorkflowRun(runId, { status: "running" });
    await updateWorkflowRun(runId, { status: "completed" });
    await waitFor(() => eventsFor(runId).length === 2);
    expect(eventsFor(runId)[1]?.status).toBe("completed");

    // A terminal run moved to another terminal status, with no reopen, stays silent.
    const relabelled = await newRun(wf.id);
    await updateWorkflowRun(relabelled, { status: "completed" });
    await waitFor(() => eventsFor(relabelled).length === 1);
    await updateWorkflowRun(relabelled, { status: "failed", error: "late failure" });
    await settle();
    expect(eventsFor(relabelled)).toEqual([
      { runId: relabelled, workflowId: wf.id, status: "completed" },
    ]);
  });

  test("fires only after commit, and never for a rolled-back end", async () => {
    const wf = await makeWorkflow("run-finished-commit");
    const committed = await newRun(wf.id);
    const rolledBack = await newRun(wf.id);

    await getDbClient().transaction(async () => {
      await updateWorkflowRun(committed, { status: "completed" });
      await settle();
      expect(eventsFor(committed)).toEqual([]);
    });
    await waitFor(() => eventsFor(committed).length === 1);

    await expect(
      getDbClient().transaction(async () => {
        await updateWorkflowRun(rolledBack, { status: "skipped" });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    await settle();
    expect(eventsFor(rolledBack)).toEqual([]);
    expect((await getWorkflowRun(rolledBack))?.status).toBe("running");
  });

  test("cancelLiveWorkflowTreeRuns fires for each run it cancels, not for terminal runs", async () => {
    const wf = await makeWorkflow("run-finished-tree-cancel");
    const live = await newRun(wf.id);
    const waiting = await newRun(wf.id);
    const done = await newRun(wf.id);
    await updateWorkflowRun(waiting, { status: "waiting" });
    await updateWorkflowRun(done, { status: "completed" });
    await waitFor(() => eventsFor(done).length === 1);

    const now = new Date().toISOString();
    await getDbClient().transaction(() =>
      cancelLiveWorkflowTreeRuns([live, waiting, done], "tree cancelled", now),
    );

    await waitFor(() => eventsFor(live).length === 1 && eventsFor(waiting).length === 1);
    expect(eventsFor(live)[0]).toEqual({ runId: live, workflowId: wf.id, status: "cancelled" });
    expect(eventsFor(waiting)[0]?.status).toBe("cancelled");
    await settle();
    expect(eventsFor(done)).toHaveLength(1);
  });

  test("a preflight failure run fires once, a deduplicated repeat does not", async () => {
    const wf = await makeWorkflow("run-finished-preflight");
    const input = {
      workflowId: wf.id,
      triggerType: "manual" as const,
      triggerData: {},
      failureReason: "needs_setup: slack",
    };
    const first = await recordWorkflowPreflightFailure(input);
    await waitFor(() => eventsFor(first.runId).length === 1);
    expect(eventsFor(first.runId)[0]?.status).toBe("failed");

    const repeat = await recordWorkflowPreflightFailure(input);
    expect(repeat.runId).toBe(first.runId);
    await settle();
    expect(eventsFor(first.runId)).toHaveLength(1);
  });

  test("a global wait filtered on a detached run's id resumes when that run ends", async () => {
    const registry = createExecutorRegistry(deps);

    // The detached run parks on a signal, so it stays live until the test ends it.
    const target = await makeWorkflow("run-finished-target", {
      nodes: [
        {
          id: "hold",
          type: "wait",
          config: { mode: "event", eventName: "test.release-target", scope: "global" },
          next: { event: "end" },
        },
        { id: "end", type: "notify", config: { channel: "swarm", template: "released" } },
      ],
    });
    const targetRunId = await startWorkflowExecution(target, {}, registry);
    expect((await getWorkflowRun(targetRunId))?.status).toBe("waiting");

    const waiter = await makeWorkflow("run-finished-waiter", {
      nodes: [
        {
          id: "watch",
          type: "wait",
          config: {
            mode: "event",
            eventName: EVENT,
            scope: "global",
            filter: { runId: targetRunId },
          },
          next: { event: "after" },
        },
        { id: "after", type: "notify", config: { channel: "swarm", template: "target ended" } },
      ],
    });
    const waiterRunId = await startWorkflowExecution(waiter, {}, registry);
    // Control: a run-scoped wait on the same event must never match another run's end.
    const scoped = await makeWorkflow("run-finished-run-scope", {
      nodes: [
        {
          id: "watch",
          type: "wait",
          config: { mode: "event", eventName: EVENT, scope: "run" },
        },
      ],
    });
    const scopedRunId = await startWorkflowExecution(scoped, {}, registry);
    await initWaitBusSubscriptions(registry);

    const watchStep = async (runId: string) =>
      (await getWorkflowRunStepsByRunId(runId)).find((step) => step.nodeId === "watch");
    const watch = await watchStep(waiterRunId);
    const scopedWatch = await watchStep(scopedRunId);
    expect((await getWaitStateByStepId(watch!.id))?.status).toBe("pending");

    // Another run ending does not match the filter.
    const other = await newRun(target.id);
    await updateWorkflowRun(other, { status: "completed" });
    await waitFor(() => eventsFor(other).length === 1);
    await settle();
    expect((await getWaitStateByStepId(watch!.id))?.status).toBe("pending");

    workflowEventBus.emit("test.release-target", {});
    await waitFor(async () => (await getWorkflowRun(targetRunId))?.status === "completed");
    await waitFor(async () => (await getWaitStateByStepId(watch!.id))?.status === "fired");

    const fired = await getWaitStateByStepId(watch!.id);
    expect(fired?.firedPayload).toEqual({
      runId: targetRunId,
      workflowId: target.id,
      status: "completed",
    });
    await waitFor(async () => (await getWorkflowRun(waiterRunId))?.status === "completed");
    expect((await getWaitStateByStepId(scopedWatch!.id))?.status).toBe("pending");
  });
});
