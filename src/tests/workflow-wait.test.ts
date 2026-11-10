import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createWorkflow, createWorkflowRun, initDb, updateWorkflowRun } from "../be/db";
import { waitForRunStatus } from "./workflow-wait";

const TEST_DB_PATH = "./test-workflow-wait.sqlite";

beforeAll(() => initDb(TEST_DB_PATH));

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

test("waitForRunStatus resolves on the expected status and names run, expectation and last status on timeout", async () => {
  const workflow = await createWorkflow({ name: "wait-helper", definition: { nodes: [] } });
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id });

  await expect(waitForRunStatus(runId, "completed", undefined, 30)).rejects.toThrow(
    `Workflow run ${runId} did not reach status "completed": last status "running" (waited 30ms)`,
  );

  setTimeout(() => void updateWorkflowRun(runId, { status: "completed" }), 20);
  expect((await waitForRunStatus(runId, "completed")).status).toBe("completed");
});
