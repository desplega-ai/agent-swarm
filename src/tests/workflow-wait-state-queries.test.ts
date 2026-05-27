import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWaitState,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDueWaitStates,
  getPendingWaitsByEvent,
  getStuckWaitRuns,
  getWaitStateById,
  getWaitStateByStepId,
  initDb,
  resolveWaitState,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { WorkflowDefinition } from "../types";

const TEST_DB_PATH = "./test-workflow-wait-state-queries.sqlite";

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

const minimalWorkflowDef: WorkflowDefinition = {
  nodes: [{ id: "n1", type: "notify", config: { message: "hi" } }],
};

async function makeWorkflow(name: string) {
  return await createWorkflow({
    name,
    definition: minimalWorkflowDef,
  });
}

function timeIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("createWaitState + getWaitStateById", () => {
  test("inserts a time-mode row and round-trips", async () => {
    const id = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const wakeUpAt = timeIso(60_000);

    const row = await createWaitState({
      id,
      workflowRunId: runId,
      workflowRunStepId: stepId,
      mode: "time",
      wakeUpAt,
    });

    expect(row.id).toBe(id);
    expect(row.mode).toBe("time");
    expect(row.status).toBe("pending");
    expect(row.wakeUpAt).toBe(wakeUpAt);
    expect(row.eventName).toBeNull();
    expect(row.expiresAt).toBeNull();

    const fetched = await getWaitStateById(id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(id);
    expect(fetched?.workflowRunId).toBe(runId);
  });

  test("inserts an event-mode row with object filter", async () => {
    const id = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const filter = { number: 42, "pr.merged": true };

    const row = await createWaitState({
      id,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: stepId,
      mode: "event",
      eventName: "github.pull_request.merged",
      eventFilter: filter,
      expiresAt: timeIso(3_600_000),
    });

    expect(row.mode).toBe("event");
    expect(row.eventName).toBe("github.pull_request.merged");
    expect(row.eventFilter).toEqual(filter);
  });

  test("inserts an event-mode row with string filter (arrow-fn body)", async () => {
    const id = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const filter = "(p) => p.number > 100";

    const row = await createWaitState({
      id,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: stepId,
      mode: "event",
      eventName: "github.pull_request.merged",
      eventFilter: filter,
    });

    expect(row.eventFilter).toBe(filter);
  });
});

describe("getWaitStateByStepId", () => {
  test("idempotency: a second create on the same stepId is detectable", async () => {
    const stepId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await createWaitState({
      id: crypto.randomUUID(),
      workflowRunId: runId,
      workflowRunStepId: stepId,
      mode: "time",
      wakeUpAt: timeIso(10_000),
    });

    const found = await getWaitStateByStepId(stepId);
    expect(found).not.toBeNull();
    expect(found?.workflowRunStepId).toBe(stepId);
  });

  test("returns null for unknown stepId", async () => {
    expect(await getWaitStateByStepId(crypto.randomUUID())).toBeNull();
  });
});

describe("getDueWaitStates", () => {
  test("returns time-mode waits with wakeUpAt in the past", async () => {
    const overdueId = crypto.randomUUID();
    const futureId = crypto.randomUUID();
    await createWaitState({
      id: overdueId,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "time",
      wakeUpAt: timeIso(-60_000), // 1 min ago
    });
    await createWaitState({
      id: futureId,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "time",
      wakeUpAt: timeIso(60_000), // 1 min from now
    });

    const due = await getDueWaitStates();
    const dueIds = new Set(due.map((r) => r.id));
    expect(dueIds.has(overdueId)).toBe(true);
    expect(dueIds.has(futureId)).toBe(false);
  });

  test("returns event-mode waits with expiresAt in the past", async () => {
    const overdueId = crypto.randomUUID();
    await createWaitState({
      id: overdueId,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "demo.signal",
      expiresAt: timeIso(-30_000),
    });

    const due = await getDueWaitStates();
    expect(due.find((r) => r.id === overdueId)).toBeDefined();
  });

  test("excludes already-fired or already-timeout rows", async () => {
    const id = crypto.randomUUID();
    await createWaitState({
      id,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "time",
      wakeUpAt: timeIso(-1_000),
    });
    const result = await resolveWaitState(id, { status: "fired" });
    expect(result.updated).toBe(true);

    const due = await getDueWaitStates();
    expect(due.find((r) => r.id === id)).toBeUndefined();
  });

  test("excludes event waits with no expiresAt (open-ended)", async () => {
    const id = crypto.randomUUID();
    await createWaitState({
      id,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "open.signal",
      // expiresAt: null — open-ended
    });
    const due = await getDueWaitStates();
    expect(due.find((r) => r.id === id)).toBeUndefined();
  });
});

describe("getPendingWaitsByEvent", () => {
  test("returns only matching pending event-mode waits", async () => {
    const matchId = crypto.randomUUID();
    const otherEventId = crypto.randomUUID();
    const timeId = crypto.randomUUID();

    await createWaitState({
      id: matchId,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "release.cut",
    });
    await createWaitState({
      id: otherEventId,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "different.signal",
    });
    await createWaitState({
      id: timeId,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "time",
      wakeUpAt: timeIso(60_000),
    });

    const pending = await getPendingWaitsByEvent("release.cut");
    const ids = new Set(pending.map((r) => r.id));
    expect(ids.has(matchId)).toBe(true);
    expect(ids.has(otherEventId)).toBe(false);
    expect(ids.has(timeId)).toBe(false);
  });

  test("runId narrows to run-scoped waits", async () => {
    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    await createWaitState({
      id: aId,
      workflowRunId: runA,
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "scoped.evt",
    });
    await createWaitState({
      id: bId,
      workflowRunId: runB,
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "scoped.evt",
    });

    const onlyA = await getPendingWaitsByEvent("scoped.evt", runA);
    expect(onlyA.map((r) => r.id)).toEqual([aId]);

    const both = await getPendingWaitsByEvent("scoped.evt");
    const ids = new Set(both.map((r) => r.id));
    expect(ids.has(aId)).toBe(true);
    expect(ids.has(bId)).toBe(true);
  });
});

describe("resolveWaitState — race-safety", () => {
  test("first caller wins, second sees updated=false", async () => {
    const id = crypto.randomUUID();
    await createWaitState({
      id,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "time",
      wakeUpAt: timeIso(-1_000),
    });

    const a = await resolveWaitState(id, { status: "fired", firedPayload: { winner: "A" } });
    const b = await resolveWaitState(id, { status: "fired", firedPayload: { winner: "B" } });

    expect(a.updated).toBe(true);
    expect(a.row?.status).toBe("fired");
    expect(a.row?.firedPayload).toEqual({ winner: "A" });

    expect(b.updated).toBe(false);
    expect(b.row).toBeNull();

    // Verify final stored state reflects A's payload
    const final = await getWaitStateById(id);
    expect(final?.firedPayload).toEqual({ winner: "A" });
    expect(final?.resolvedAt).not.toBeNull();
  });

  test("transitions to timeout status without payload", async () => {
    const id = crypto.randomUUID();
    await createWaitState({
      id,
      workflowRunId: crypto.randomUUID(),
      workflowRunStepId: crypto.randomUUID(),
      mode: "event",
      eventName: "evt",
      expiresAt: timeIso(-1_000),
    });

    const r = await resolveWaitState(id, { status: "timeout" });
    expect(r.updated).toBe(true);
    expect(r.row?.status).toBe("timeout");
    expect(r.row?.firedPayload).toBeNull();
  });

  test("returns updated=false for unknown id", async () => {
    const r = await resolveWaitState(crypto.randomUUID(), { status: "fired" });
    expect(r.updated).toBe(false);
  });
});

describe("getStuckWaitRuns", () => {
  // The query JOINs workflow_runs (waiting) → workflow_run_steps (waiting,
  // nodeType='wait') → wait_states. We build that triple via the public
  // helpers so the test mirrors what `recoverWaitStates` will see in production.
  test("returns waits whose run+step are 'waiting' and wait_state is overdue (case b)", async () => {
    const wf = await makeWorkflow("stuck-wait-overdue");
    const run = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: wf.id,
    });
    await updateWorkflowRun(run.id, { status: "waiting" });

    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w1",
      nodeType: "wait",
    });
    await updateWorkflowRunStep(step.id, { status: "waiting" });

    const overdueId = crypto.randomUUID();
    await createWaitState({
      id: overdueId,
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "time",
      wakeUpAt: timeIso(-60_000),
    });

    const stuck = await getStuckWaitRuns();
    const stuckIds = new Set(stuck.map((r) => r.waitId));
    expect(stuckIds.has(overdueId)).toBe(true);
    const found = stuck.find((r) => r.waitId === overdueId);
    expect(found?.runId).toBe(run.id);
    expect(found?.stepId).toBe(step.id);
    expect(found?.waitMode).toBe("time");
    expect(found?.waitStatus).toBe("pending");
  });

  test("returns waits whose status is non-pending while the step is still waiting (case a)", async () => {
    const wf = await makeWorkflow("stuck-wait-fired-while-down");
    const run = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: wf.id,
    });
    await updateWorkflowRun(run.id, { status: "waiting" });

    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w2",
      nodeType: "wait",
    });
    await updateWorkflowRunStep(step.id, { status: "waiting" });

    const firedId = crypto.randomUUID();
    await createWaitState({
      id: firedId,
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "event",
      eventName: "x",
    });
    await resolveWaitState(firedId, { status: "fired", firedPayload: { hello: "world" } });

    const stuck = await getStuckWaitRuns();
    const found = stuck.find((r) => r.waitId === firedId);
    expect(found).toBeDefined();
    expect(found?.waitStatus).toBe("fired");
  });

  test("excludes runs that aren't 'waiting' or steps that aren't 'wait' nodeType", async () => {
    const wf = await makeWorkflow("stuck-wait-excludes");
    // Run NOT in waiting state — should be excluded.
    const run = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    // Leave run.status default (running)
    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "w3",
      nodeType: "wait",
    });
    await updateWorkflowRunStep(step.id, { status: "waiting" });

    const id = crypto.randomUUID();
    await createWaitState({
      id,
      workflowRunId: run.id,
      workflowRunStepId: step.id,
      mode: "time",
      wakeUpAt: timeIso(-60_000),
    });

    const stuck = await getStuckWaitRuns();
    expect(stuck.find((r) => r.waitId === id)).toBeUndefined();
  });
});
