import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createTaskExtended,
  createWorkflow,
  deleteWorkflow,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  updateTask,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution, walkGraph } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-async-v2.sqlite";

// ─── Test Executors ──────────────────────────────────────────

class EchoExecutor extends BaseExecutor<typeof EchoExecutor.schema, typeof EchoExecutor.outSchema> {
  static readonly schema = z.object({ message: z.string() });
  static readonly outSchema = z.object({ echo: z.string() });

  readonly type = "echo";
  readonly mode = "instant" as const;
  readonly configSchema = EchoExecutor.schema;
  readonly outputSchema = EchoExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof EchoExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof EchoExecutor.outSchema>>> {
    return { status: "success", output: { echo: config.message } };
  }
}

class NotifyStubExecutor extends BaseExecutor<
  typeof NotifyStubExecutor.schema,
  typeof NotifyStubExecutor.outSchema
> {
  static readonly schema = z.object({ channel: z.string(), template: z.string() });
  static readonly outSchema = z.object({ sent: z.boolean() });

  readonly type = "notify";
  readonly mode = "instant" as const;
  readonly configSchema = NotifyStubExecutor.schema;
  readonly outputSchema = NotifyStubExecutor.outSchema;

  protected async execute(): Promise<ExecutorResult<z.infer<typeof NotifyStubExecutor.outSchema>>> {
    return { status: "success", output: { sent: true } };
  }
}

// ─── Mock Dependencies ───────────────────────────────────────

import * as db from "../be/db";

const mockDeps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate,
};

function createTestRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new EchoExecutor(mockDeps));
  registry.register(new NotifyStubExecutor(mockDeps));
  registry.register(new AgentTaskExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

function makeWorkflow(def: WorkflowDefinition, overrides?: Partial<Workflow>): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
    name: overrides?.name || `test-async-${workflowCounter}-${Date.now()}`,
    definition: def,
  });
  createdWorkflowIds.push(workflow.id);
  return { ...workflow, ...overrides };
}

// ─── Setup / Teardown ────────────────────────────────────────

let registry: ExecutorRegistry;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  registry = createTestRegistry();
  // Wire up resume listener
  setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  // Cleanup workflows
  for (const id of createdWorkflowIds) {
    try {
      deleteWorkflow(id);
    } catch {}
  }
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

// ─── Tests ───────────────────────────────────────────────────

describe("Workflow Async v2 (Phase 4)", () => {
  describe("Agent-Task Executor", () => {
    test("creates a task with correct fields (source, workflowRunId, etc.)", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Do the thing" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, { test: true }, registry);
      const run = getWorkflowRun(runId);
      expect(run).toBeTruthy();
      expect(run!.status).toBe("waiting");

      // Verify step was created and is waiting
      const steps = getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.status).toBe("waiting");
      expect(steps[0]!.nodeType).toBe("agent-task");

      // Verify a task was created in agent_tasks
      const task = getTaskByWorkflowRunStepId(steps[0]!.id);
      expect(task).toBeTruthy();
      expect(task!.source).toBe("workflow");
      expect(task!.workflowRunId).toBe(runId);
      expect(task!.workflowRunStepId).toBe(steps[0]!.id);
      expect(task!.task).toBe("Do the thing");
    });

    test("workflow pauses at waiting when hitting async executor", async () => {
      const workflow = makeWorkflow({
        nodes: [
          { id: "s1", type: "echo", config: { message: "prep" }, next: "task1" },
          { id: "task1", type: "agent-task", config: { template: "Work: {{s1.echo}}" } },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("waiting");

      // Echo step should be completed, task step should be waiting
      const steps = getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(2);
      const echoStep = steps.find((s) => s.nodeId === "s1");
      const taskStep = steps.find((s) => s.nodeId === "task1");
      expect(echoStep!.status).toBe("completed");
      expect(taskStep!.status).toBe("waiting");

      // The task description should have interpolated context
      const task = getTaskByWorkflowRunStepId(taskStep!.id);
      expect(task!.task).toBe("Work: prep");
    });

    test("resume from task completion continues the workflow", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Do something" },
            next: "done",
          },
          {
            id: "done",
            type: "notify",
            config: { channel: "swarm", template: "Finished: {{task1.taskOutput}}" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      expect(getWorkflowRun(runId)!.status).toBe("waiting");

      // Find the task
      const steps = getWorkflowRunStepsByRunId(runId);
      const taskStep = steps.find((s) => s.nodeId === "task1")!;
      const task = getTaskByWorkflowRunStepId(taskStep.id)!;

      // Simulate task completion via event bus
      workflowEventBus.emit("task.completed", {
        taskId: task.id,
        output: "task result data",
        workflowRunId: runId,
        workflowRunStepId: taskStep.id,
      });

      // Give the async handler time to process
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Workflow should be completed now
      const updatedRun = getWorkflowRun(runId);
      expect(updatedRun!.status).toBe("completed");

      // Both steps should be completed (task1 + done)
      const updatedSteps = getWorkflowRunStepsByRunId(runId);
      expect(updatedSteps).toHaveLength(2);
      const completedSteps = updatedSteps.filter((s) => s.status === "completed");
      expect(completedSteps).toHaveLength(2);
    });

    test("resume from task failure marks run as failed", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Failing task" },
            next: "done",
          },
          {
            id: "done",
            type: "notify",
            config: { channel: "swarm", template: "Should not reach" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      expect(getWorkflowRun(runId)!.status).toBe("waiting");

      const steps = getWorkflowRunStepsByRunId(runId);
      const taskStep = steps.find((s) => s.nodeId === "task1")!;
      const task = getTaskByWorkflowRunStepId(taskStep.id)!;

      // Simulate task failure
      workflowEventBus.emit("task.failed", {
        taskId: task.id,
        failureReason: "Agent could not complete",
        workflowRunId: runId,
        workflowRunStepId: taskStep.id,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const updatedRun = getWorkflowRun(runId);
      expect(updatedRun!.status).toBe("failed");
      expect(updatedRun!.error).toContain("Agent could not complete");
    });

    test("resume from task cancellation marks run as failed", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Cancelled task" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      expect(getWorkflowRun(runId)!.status).toBe("waiting");

      const steps = getWorkflowRunStepsByRunId(runId);
      const taskStep = steps.find((s) => s.nodeId === "task1")!;
      const task = getTaskByWorkflowRunStepId(taskStep.id)!;

      workflowEventBus.emit("task.cancelled", {
        taskId: task.id,
        workflowRunId: runId,
        workflowRunStepId: taskStep.id,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const updatedRun = getWorkflowRun(runId);
      expect(updatedRun!.status).toBe("failed");
      expect(updatedRun!.error).toContain("cancelled");
    });

    test("idempotency: no duplicate task created on re-execution", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Idempotent task" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      const steps = getWorkflowRunStepsByRunId(runId);
      const taskStep = steps.find((s) => s.nodeId === "task1")!;
      const task = getTaskByWorkflowRunStepId(taskStep.id)!;

      // Re-run the executor for the same step (simulates recovery/retry)
      const executor = new AgentTaskExecutor(mockDeps);
      const result = await executor.run({
        config: { template: "Idempotent task" },
        context: {},
        meta: {
          runId,
          stepId: taskStep.id,
          nodeId: "task1",
          workflowId: workflow.id,
          dryRun: false,
        },
      });

      // Should return async with the same task ID — no new task created
      expect((result as Record<string, unknown>).async).toBe(true);
      expect((result as Record<string, unknown>).correlationId).toBe(task.id);

      // Verify only one task exists for this step
      const taskAgain = getTaskByWorkflowRunStepId(taskStep.id);
      expect(taskAgain!.id).toBe(task.id);
    });
  });

  describe("Agent-Task Executor config", () => {
    test("interpolates template with context", async () => {
      const workflow = makeWorkflow({
        nodes: [
          { id: "s1", type: "echo", config: { message: "hello" }, next: "task1" },
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Process: {{s1.echo}}" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      const steps = getWorkflowRunStepsByRunId(runId);
      const taskStep = steps.find((s) => s.nodeId === "task1")!;
      const task = getTaskByWorkflowRunStepId(taskStep.id)!;
      expect(task.task).toBe("Process: hello");
    });

    test("passes priority and tags to created task", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: {
              template: "Tagged task",
              tags: ["workflow", "test"],
              priority: 80,
            },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, {}, registry);
      const steps = getWorkflowRunStepsByRunId(runId);
      const taskStep = steps.find((s) => s.nodeId === "task1")!;
      const task = getTaskByWorkflowRunStepId(taskStep.id)!;
      expect(task.priority).toBe(80);
      expect(task.tags).toEqual(["workflow", "test"]);
    });
  });
});
