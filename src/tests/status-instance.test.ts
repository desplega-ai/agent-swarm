import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  failTask,
  initDb,
  updateWorkflowRun,
} from "../be/db";
import { getInstanceFeedbackSignals } from "../be/db/instance-signals";

const TEST_DB_PATH = "./test-status-instance.sqlite";
const LEAD_ID = "aaaa0000-0000-4000-8000-0000000000f1";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // Not there.
    }
  }
}

describe("/status instance signals", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  test("an empty install reports zeros and no anchor", async () => {
    expect(await getInstanceFeedbackSignals()).toEqual({
      first_seen_at: null,
      tasks_completed: 0,
      tasks_failed: 0,
      workflow_runs_completed: 0,
    });
  });

  test("counts completed and failed tasks, completed runs, and the oldest agent", async () => {
    const lead = await createAgent({ id: LEAD_ID, name: "Lead", isLead: true, status: "idle" });
    for (const outcome of ["done", "done", "fail", "open"]) {
      const task = await createTaskExtended(`task ${outcome}`, { agentId: LEAD_ID, source: "api" });
      if (outcome === "done") await completeTask(task.id, "ok");
      if (outcome === "fail") await failTask(task.id, "nope");
    }
    const workflow = await createWorkflow({
      name: "Feedback signals",
      definition: { nodes: [{ id: "start", type: "echo", config: {} }] },
    });
    await createWorkflowRun({ id: crypto.randomUUID(), workflowId: workflow.id });
    const done = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: workflow.id });
    await updateWorkflowRun(done.id, { status: "completed", finishedAt: new Date().toISOString() });

    expect(await getInstanceFeedbackSignals()).toEqual({
      first_seen_at: lead.createdAt,
      tasks_completed: 2,
      tasks_failed: 1,
      workflow_runs_completed: 1,
    });
  });
});
