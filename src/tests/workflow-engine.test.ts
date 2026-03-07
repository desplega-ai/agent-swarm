import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  getAllTasks,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import { findEntryNodes, getSuccessors, startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-engine.sqlite";

describe("Workflow Engine", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
    initDb(TEST_DB_PATH);
    // Wire up the resume listener for async resume tests
    setupWorkflowResumeListener(workflowEventBus);
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
  // interpolate()
  // ---------------------------------------------------------------------------
  describe("interpolate()", () => {
    test("replaces a simple token", () => {
      expect(interpolate("{{trigger.title}}", { trigger: { title: "Bug fix" } })).toBe("Bug fix");
    });

    test("replaces multiple tokens", () => {
      expect(interpolate("{{a}} and {{b}}", { a: "foo", b: "bar" })).toBe("foo and bar");
    });

    test("returns empty string for missing path", () => {
      expect(interpolate("{{missing.key}}", {})).toBe("");
    });

    test("serialises objects as JSON", () => {
      const result = interpolate("{{obj}}", { obj: { x: 1 } });
      expect(result).toBe('{"x":1}');
    });

    test("leaves template unchanged when no tokens present", () => {
      expect(interpolate("no tokens here", {})).toBe("no tokens here");
    });
  });

  // ---------------------------------------------------------------------------
  // findEntryNodes() / getSuccessors()
  // ---------------------------------------------------------------------------
  describe("graph helpers", () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger-new-task", config: {} },
        { id: "pm1", type: "property-match", config: { conditions: [] } },
        { id: "ct1", type: "create-task", config: { template: "do something" } },
      ],
      edges: [
        { id: "e1", source: "t1", sourcePort: "default", target: "pm1" },
        { id: "e2", source: "pm1", sourcePort: "true", target: "ct1" },
      ],
    };

    test("findEntryNodes returns nodes with no incoming edges", () => {
      const entries = findEntryNodes(def);
      expect(entries.map((n) => n.id)).toEqual(["t1"]);
    });

    test("getSuccessors returns correct successors for a port", () => {
      const successors = getSuccessors(def, "pm1", "true");
      expect(successors.map((n) => n.id)).toEqual(["ct1"]);
    });

    test("getSuccessors returns empty array for a port with no outgoing edges", () => {
      const successors = getSuccessors(def, "pm1", "false");
      expect(successors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // property-match: failing condition → create-task never reached
  // ---------------------------------------------------------------------------
  describe("property-match with failing condition", () => {
    test("create-task node is skipped when condition is false", async () => {
      const workflow = createWorkflow({
        name: "test-property-match-fail",
        definition: {
          nodes: [
            { id: "t1", type: "trigger-new-task", config: {} },
            {
              id: "pm1",
              type: "property-match",
              config: {
                conditions: [{ field: "trigger.source", op: "eq", value: "slack" }],
              },
            },
            { id: "ct1", type: "create-task", config: { template: "SHOULD NOT APPEAR" } },
          ],
          edges: [
            { id: "e1", source: "t1", sourcePort: "default", target: "pm1" },
            // ct1 is only reachable via "true" port
            { id: "e2", source: "pm1", sourcePort: "true", target: "ct1" },
          ],
        },
      });

      const tasksBefore = getAllTasks().length;

      const runId = await startWorkflowExecution(workflow, { source: "api" });

      const run = getWorkflowRun(runId);
      // Run should have completed — no async nodes were reached
      expect(run?.status).toBe("completed");

      // No task should have been created
      const tasksAfter = getAllTasks().length;
      expect(tasksAfter).toBe(tasksBefore);

      // Steps: trigger + property-match; ct1 should NOT have a step
      const steps = getWorkflowRunStepsByRunId(runId);
      const stepNodeIds = steps.map((s) => s.nodeId);
      expect(stepNodeIds).toContain("t1");
      expect(stepNodeIds).toContain("pm1");
      expect(stepNodeIds).not.toContain("ct1");
    });
  });

  // ---------------------------------------------------------------------------
  // Full 3-node workflow: trigger → property-match → create-task
  // ---------------------------------------------------------------------------
  describe("3-node workflow: trigger → property-match → create-task", () => {
    test("run is 'waiting' after reaching async create-task node", async () => {
      const workflow = createWorkflow({
        name: "test-full-workflow",
        definition: {
          nodes: [
            { id: "t1", type: "trigger-new-task", config: {} },
            {
              id: "pm1",
              type: "property-match",
              config: {
                conditions: [{ field: "trigger.source", op: "eq", value: "api" }],
              },
            },
            {
              id: "ct1",
              type: "create-task",
              config: { template: "Handle {{trigger.source}} event" },
            },
          ],
          edges: [
            { id: "e1", source: "t1", sourcePort: "default", target: "pm1" },
            { id: "e2", source: "pm1", sourcePort: "true", target: "ct1" },
          ],
        },
      });

      const runId = await startWorkflowExecution(workflow, { source: "api" });

      // Run should be waiting (paused at async create-task node)
      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("waiting");

      // Steps should exist for all nodes up to and including create-task
      const steps = getWorkflowRunStepsByRunId(runId);
      const stepNodeIds = steps.map((s) => s.nodeId);
      expect(stepNodeIds).toContain("t1");
      expect(stepNodeIds).toContain("pm1");
      expect(stepNodeIds).toContain("ct1");

      // The create-task step should be 'waiting'
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      expect(ctStep.status).toBe("waiting");

      // An agent_tasks row should have been created, linked to this run
      const tasks = getAllTasks();
      const workflowTask = tasks.find(
        (t) => t.workflowRunId === runId && t.workflowRunStepId === ctStep.id,
      );
      expect(workflowTask).toBeDefined();
      expect(workflowTask?.task).toBe("Handle api event");
    });
  });

  // ---------------------------------------------------------------------------
  // Resume: task.completed event resumes and completes the run
  // ---------------------------------------------------------------------------
  describe("resume on task.completed event", () => {
    test("workflow run transitions to 'completed' after task.completed event", async () => {
      const workflow = createWorkflow({
        name: "test-resume-workflow",
        definition: {
          nodes: [
            { id: "t1", type: "trigger-new-task", config: {} },
            {
              id: "ct1",
              type: "create-task",
              config: { template: "Async task {{trigger.id}}" },
            },
          ],
          edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "ct1" }],
        },
      });

      const runId = await startWorkflowExecution(workflow, { id: "evt-42" });

      // Should be waiting at the create-task step
      const runBefore = getWorkflowRun(runId);
      expect(runBefore?.status).toBe("waiting");

      const steps = getWorkflowRunStepsByRunId(runId);
      const ctStep = steps.find((s) => s.nodeId === "ct1")!;
      expect(ctStep).toBeDefined();

      // Find the created agent task
      const tasks = getAllTasks();
      const workflowTask = tasks.find((t) => t.workflowRunId === runId);
      expect(workflowTask).toBeDefined();

      // Simulate task.completed event — this is what db.completeTask() would emit
      workflowEventBus.emit("task.completed", {
        taskId: workflowTask!.id,
        output: "done!",
        workflowRunId: runId,
        workflowRunStepId: ctStep.id,
      });

      // Give the async listener a tick to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      const runAfter = getWorkflowRun(runId);
      expect(runAfter?.status).toBe("completed");
    });
  });
});
