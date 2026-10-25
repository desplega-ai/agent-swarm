import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getLatestStepForNode,
  getWorkflowRunStepsByRunId,
  initDb,
  updateWorkflowRunStep,
} from "../be/db";
import { hasRunningStep } from "../workflows/engine";

const TEST_DB_PATH = "./test-workflow-step-order.sqlite";

// Steps inserted in the same millisecond share `startedAt`. Reads must still
// return them in insert order, because the engine treats the last row of a
// node as its latest step.
describe("workflow run step order with equal startedAt", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
  });

  afterEach(() => {
    setSystemTime();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // File doesn't exist
      }
    }
  });

  async function createRun(): Promise<string> {
    const workflow = await createWorkflow({
      name: `step-order-${crypto.randomUUID()}`,
      definition: { nodes: [{ id: "a", type: "echo", config: { message: "hi" } }] },
    });
    const runId = crypto.randomUUID();
    await createWorkflowRun({ id: runId, workflowId: workflow.id });
    return runId;
  }

  // Ids sort opposite to insert order, so an id tiebreaker would also fail.
  async function insertTwoSteps(runId: string): Promise<[string, string]> {
    setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    const first = `z-${crypto.randomUUID()}`;
    const second = `a-${crypto.randomUUID()}`;
    await createWorkflowRunStep({ id: first, runId, nodeId: "a", nodeType: "echo" });
    await createWorkflowRunStep({ id: second, runId, nodeId: "a", nodeType: "echo" });
    return [first, second];
  }

  test("getWorkflowRunStepsByRunId returns steps in insert order", async () => {
    const runId = await createRun();
    const [first, second] = await insertTwoSteps(runId);

    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps[0]?.startedAt).toBe(steps[1]?.startedAt);
    expect(steps.map((s) => s.id)).toEqual([first, second]);
  });

  test("getLatestStepForNode returns the step inserted last", async () => {
    const runId = await createRun();
    const [, second] = await insertTwoSteps(runId);

    const latest = await getLatestStepForNode(runId, "a");
    expect(latest?.id).toBe(second);
  });

  test("hasRunningStep ignores a running step superseded at the same startedAt", async () => {
    const runId = await createRun();
    const [, second] = await insertTwoSteps(runId);
    await updateWorkflowRunStep(second, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    expect(hasRunningStep(await getWorkflowRunStepsByRunId(runId))).toBe(false);
  });
});
