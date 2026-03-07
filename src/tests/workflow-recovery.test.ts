import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  getAllTasks,
  getDb,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { recoverStuckWorkflowRuns } from "../workflows/recovery";

const TEST_DB_PATH = "./test-workflow-recovery.sqlite";

// A minimal workflow with a trigger → create-task (async node)
// so execution pauses in 'waiting' state after the first run.
const WAITING_WORKFLOW_DEF: WorkflowDefinition = {
  nodes: [
    { id: "t1", type: "trigger-new-task", config: {} },
    { id: "ct1", type: "create-task", config: { template: "Recovery test task" } },
  ],
  edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "ct1" }],
};

describe("Workflow Recovery", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // ---------------------------------------------------------------------------
  // Recovery: task completed → run resumes and completes
  // ---------------------------------------------------------------------------
  describe("recoverStuckWorkflowRuns() with completed task", () => {
    test("resumes a waiting run to completed when linked task is completed", async () => {
      const workflow = createWorkflow({
        name: "recovery-test-completed",
        definition: WAITING_WORKFLOW_DEF,
      });

      // Start execution — pauses at the create-task node
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      // Confirm the run is waiting
      const runBefore = getWorkflowRun(runId);
      expect(runBefore?.status).toBe("waiting");

      // Find the linked agent task
      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId);
      expect(workflowTask).toBeDefined();

      // Simulate the task completing (bypass event bus — directly update DB status)
      getDb().run(
        "UPDATE agent_tasks SET status = 'completed', output = ?, finishedAt = datetime('now') WHERE id = ?",
        ["task output value", workflowTask!.id],
      );

      // Recovery should pick it up and resume the run
      const recovered = await recoverStuckWorkflowRuns();
      expect(recovered).toBe(1);

      // Run should now be completed (no more nodes after ct1)
      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("completed");

      // The waiting step should be marked completed
      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      expect(ctStep.status).toBe("completed");
      expect(ctStep.finishedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery: task failed → run marked failed
  // ---------------------------------------------------------------------------
  describe("recoverStuckWorkflowRuns() with failed task", () => {
    test("marks run as failed when linked task has failed", async () => {
      const workflow = createWorkflow({
        name: "recovery-test-failed",
        definition: WAITING_WORKFLOW_DEF,
      });

      const runId = await startWorkflowExecution(workflow, { source: "test" });

      const runBefore = getWorkflowRun(runId);
      expect(runBefore?.status).toBe("waiting");

      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId);
      expect(workflowTask).toBeDefined();

      // Simulate the task failing
      getDb().run(
        "UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = datetime('now') WHERE id = ?",
        ["something went wrong", workflowTask!.id],
      );

      const recovered = await recoverStuckWorkflowRuns();
      expect(recovered).toBe(1);

      // Run should be marked failed
      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("failed");
      expect(runAfter?.error).toBe("Task failed");

      // The waiting step should be marked failed
      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      expect(ctStep.status).toBe("failed");
      expect(ctStep.error).toBe("Task failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery: task cancelled → run marked failed with "Task cancelled" message
  // ---------------------------------------------------------------------------
  describe("recoverStuckWorkflowRuns() with cancelled task", () => {
    test("marks run as failed with 'Task cancelled' when linked task is cancelled", async () => {
      const workflow = createWorkflow({
        name: "recovery-test-cancelled",
        definition: WAITING_WORKFLOW_DEF,
      });

      const runId = await startWorkflowExecution(workflow, { source: "test" });

      const runBefore = getWorkflowRun(runId);
      expect(runBefore?.status).toBe("waiting");

      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId);
      expect(workflowTask).toBeDefined();

      // Simulate the task being cancelled
      getDb().run(
        "UPDATE agent_tasks SET status = 'cancelled', finishedAt = datetime('now') WHERE id = ?",
        [workflowTask!.id],
      );

      const recovered = await recoverStuckWorkflowRuns();
      expect(recovered).toBe(1);

      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("failed");
      expect(runAfter?.error).toBe("Task cancelled");

      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      expect(ctStep.status).toBe("failed");
      expect(ctStep.error).toBe("Task cancelled");
    });
  });

  // ---------------------------------------------------------------------------
  // No stuck runs → returns 0
  // ---------------------------------------------------------------------------
  describe("recoverStuckWorkflowRuns() with no stuck runs", () => {
    test("returns 0 when there are no stuck workflow runs", async () => {
      // Any runs from previous tests are already in terminal states —
      // only 'waiting' runs with terminal tasks qualify as stuck.
      const recovered = await recoverStuckWorkflowRuns();
      expect(recovered).toBe(0);
    });
  });
});
