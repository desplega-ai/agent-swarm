import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getWorkflowRun,
  getWorkflowRunStep,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import {
  checkpointPortStepAndResolveSuccessors,
  failStepAndRunIfWaiting,
} from "../workflows/task-step-routing";

const TEST_DB_PATH = "./test-workflow-step-claims.sqlite";

// Approval-shaped definition with port-based routing so the port claim
// resolves real successors.
const def: WorkflowDefinition = {
  nodes: [
    {
      id: "gate",
      type: "approval",
      config: {},
      next: { approved: "after-approve", rejected: "after-reject" },
    },
    { id: "after-approve", type: "script", config: {} },
    { id: "after-reject", type: "script", config: {} },
  ],
  onNodeFailure: "fail",
};

async function clearDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

/** Create a run with one step parked in `waiting` (run `waiting` too). */
async function createWaitingStep(): Promise<{ runId: string; stepId: string }> {
  const workflow = await createWorkflow({
    name: `test-step-claims-${crypto.randomUUID()}`,
    definition: def,
  });
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id });
  const stepId = crypto.randomUUID();
  await createWorkflowRunStep({ id: stepId, runId, nodeId: "gate", nodeType: "approval" });
  await updateWorkflowRunStep(stepId, { status: "waiting" });
  await updateWorkflowRun(runId, { status: "waiting" });
  return { runId, stepId };
}

beforeAll(async () => {
  await clearDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await clearDb();
});

describe("failStepAndRunIfWaiting", () => {
  test("two concurrent failers: exactly one claims", async () => {
    const { runId, stepId } = await createWaitingStep();
    // The live task.failed handler and the recovery sweep both saw `waiting`
    // before their awaits; only the transactional re-read may win.
    const [a, b] = await Promise.all([
      failStepAndRunIfWaiting(stepId, runId, "live event"),
      failStepAndRunIfWaiting(stepId, runId, "recovery sweep"),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    const step = await getWorkflowRunStep(stepId);
    const run = await getWorkflowRun(runId);
    expect(step?.status).toBe("failed");
    expect(run?.status).toBe("failed");
    // The loser must not have overwritten the winner's reason.
    expect(step?.error).toBe(a ? "live event" : "recovery sweep");
  });

  test("does not stomp a step another handler already routed", async () => {
    const { runId, stepId } = await createWaitingStep();
    await updateWorkflowRunStep(stepId, { status: "completed" });
    await updateWorkflowRun(runId, { status: "running" });
    expect(await failStepAndRunIfWaiting(stepId, runId, "stale sweep")).toBe(false);
    expect((await getWorkflowRunStep(stepId))?.status).toBe("completed");
    expect((await getWorkflowRun(runId))?.status).toBe("running");
  });
});

describe("checkpointPortStepAndResolveSuccessors", () => {
  test("two concurrent resumes: exactly one claims and routes", async () => {
    const { runId, stepId } = await createWaitingStep();
    const ctx: Record<string, unknown> = {};
    // The approval.resolved bus event and the heartbeat recovery sweep race.
    const [a, b] = await Promise.all([
      checkpointPortStepAndResolveSuccessors(
        def,
        runId,
        stepId,
        "gate",
        { ok: 1 },
        "approved",
        ctx,
      ),
      checkpointPortStepAndResolveSuccessors(
        def,
        runId,
        stepId,
        "gate",
        { ok: 1 },
        "approved",
        ctx,
      ),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean).length).toBe(1);
    const winner = a.claimed ? a : b;
    const loser = a.claimed ? b : a;
    expect(winner.successors.map((n) => n.id)).toEqual(["after-approve"]);
    expect(loser.successors).toEqual([]);
    expect((await getWorkflowRunStep(stepId))?.status).toBe("completed");
    expect((await getWorkflowRun(runId))?.status).toBe("running");
  });

  test("port claim then fail claim: the fail loses", async () => {
    // Mixed path: an approval resolution routes the step, then a stale
    // task-failure event tries to fail the run. It must bounce.
    const { runId, stepId } = await createWaitingStep();
    const routing = await checkpointPortStepAndResolveSuccessors(
      def,
      runId,
      stepId,
      "gate",
      { ok: 1 },
      "rejected",
      {},
    );
    expect(routing.claimed).toBe(true);
    expect(routing.successors.map((n) => n.id)).toEqual(["after-reject"]);
    expect(await failStepAndRunIfWaiting(stepId, runId, "late failure")).toBe(false);
    expect((await getWorkflowRunStep(stepId))?.status).toBe("completed");
    expect((await getWorkflowRun(runId))?.status).toBe("running");
  });
});
