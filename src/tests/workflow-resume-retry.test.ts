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
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import { retryFailedRun, setupWorkflowResumeListener } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-resume-retry.sqlite";

const SIMPLE_WORKFLOW_DEF: WorkflowDefinition = {
  nodes: [
    { id: "t1", type: "trigger-new-task", config: {} },
    { id: "ct1", type: "create-task", config: { template: "Resume test task" } },
  ],
  edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "ct1" }],
};

describe("Workflow Resume & Retry", () => {
  let eventBus: InProcessEventBus;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
    eventBus = new InProcessEventBus();
    setupWorkflowResumeListener(eventBus);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // File may not exist
      }
    }
  });

  // ---------------------------------------------------------------------------
  // task.failed event through resume listener
  // ---------------------------------------------------------------------------
  describe("task.failed event via resume listener", () => {
    test("marks run and step as failed", async () => {
      const workflow = createWorkflow({
        name: "resume-failed-test",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      const runBefore = getWorkflowRun(runId);
      expect(runBefore?.status).toBe("waiting");

      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId)!;

      eventBus.emit("task.failed", {
        taskId: workflowTask.id,
        workflowRunId: runId,
        workflowRunStepId: ctStep.id,
        failureReason: "Out of memory",
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("failed");
      expect(runAfter?.error).toBe("Out of memory");

      const stepsAfter = getWorkflowRunStepsByRunId(runId);
      const ctStepAfter = stepsAfter.find((s) => s.nodeId === "ct1")!;
      expect(ctStepAfter.status).toBe("failed");
      expect(ctStepAfter.error).toBe("Out of memory");
    });
  });

  // ---------------------------------------------------------------------------
  // task.cancelled event through resume listener
  // ---------------------------------------------------------------------------
  describe("task.cancelled event via resume listener", () => {
    test("marks run and step as failed with cancellation message", async () => {
      const workflow = createWorkflow({
        name: "resume-cancelled-test",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId)!;

      eventBus.emit("task.cancelled", {
        taskId: workflowTask.id,
        workflowRunId: runId,
        workflowRunStepId: ctStep.id,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("failed");
      expect(runAfter?.error).toBe("Task was cancelled");
    });
  });

  // ---------------------------------------------------------------------------
  // Events without workflow metadata are ignored
  // ---------------------------------------------------------------------------
  describe("events without workflow metadata", () => {
    test("task.completed without workflowRunId is ignored", async () => {
      const workflow = createWorkflow({
        name: "resume-ignored-test",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      // Emit event without workflowRunId — should be ignored
      eventBus.emit("task.completed", {
        taskId: "random-task",
        output: "done",
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Run should still be waiting (not affected)
      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("waiting");
    });

    test("task.failed without workflowRunStepId is ignored", async () => {
      const workflow = createWorkflow({
        name: "resume-ignored-test-2",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      eventBus.emit("task.failed", {
        taskId: "random-task",
        workflowRunId: runId,
        // No workflowRunStepId
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("waiting");
    });
  });

  // ---------------------------------------------------------------------------
  // retryFailedRun()
  // ---------------------------------------------------------------------------
  describe("retryFailedRun()", () => {
    test("retries a failed run and resumes execution", async () => {
      const workflow = createWorkflow({ name: "retry-test", definition: SIMPLE_WORKFLOW_DEF });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      // Manually fail the run and step
      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;

      getDb().run(
        "UPDATE workflow_run_steps SET status = 'failed', error = 'test error' WHERE id = ?",
        [ctStep.id],
      );
      getDb().run("UPDATE workflow_runs SET status = 'failed', error = 'test error' WHERE id = ?", [
        runId,
      ]);

      const runBefore = getWorkflowRun(runId);
      expect(runBefore?.status).toBe("failed");

      // Retry — should re-execute from the failed node
      await retryFailedRun(runId);

      // After retry, the run should be waiting again (create-task is async)
      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("waiting");
    });

    test("throws when run is not in failed state", async () => {
      const workflow = createWorkflow({
        name: "retry-not-failed",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      // Run is in 'waiting' state, not 'failed'
      expect(retryFailedRun(runId)).rejects.toThrow("Run is not in failed state");
    });

    test("throws when run does not exist", async () => {
      expect(retryFailedRun("nonexistent-run-id")).rejects.toThrow("Run is not in failed state");
    });

    test("throws when no failed step exists", async () => {
      const workflow = createWorkflow({
        name: "retry-no-failed-step",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      // Mark run as failed but leave steps as-is (waiting)
      getDb().run("UPDATE workflow_runs SET status = 'failed', error = 'test' WHERE id = ?", [
        runId,
      ]);

      expect(retryFailedRun(runId)).rejects.toThrow("No failed step found");
    });
  });

  // ---------------------------------------------------------------------------
  // Resume guard: run not in waiting state
  // ---------------------------------------------------------------------------
  describe("resume guards", () => {
    test("task.completed is ignored when run is already completed", async () => {
      const workflow = createWorkflow({
        name: "resume-already-done",
        definition: SIMPLE_WORKFLOW_DEF,
      });
      const runId = await startWorkflowExecution(workflow, { source: "test" });

      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId)!;

      // Manually mark run as completed
      getDb().run("UPDATE workflow_runs SET status = 'completed' WHERE id = ?", [runId]);

      eventBus.emit("task.completed", {
        taskId: workflowTask.id,
        output: "done",
        workflowRunId: runId,
        workflowRunStepId: ctStep.id,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still be completed (not changed)
      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("completed");
    });
  });
});
