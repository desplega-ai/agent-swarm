import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createApprovalRequest,
  createWorkflow,
  deleteWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-hitl-routing.sqlite";

// ─── Test Executors ──────────────────────────────────────────

/** A mock async executor that simulates HITL behavior — returns async result to pause the workflow */
class MockHITLExecutor extends BaseExecutor<
  typeof MockHITLExecutor.schema,
  typeof MockHITLExecutor.outSchema
> {
  static readonly schema = z.object({ title: z.string() });
  static readonly outSchema = z.object({
    requestId: z.string(),
    status: z.string(),
    responses: z.record(z.string(), z.unknown()).nullable(),
  });

  readonly type = "mock-hitl";
  readonly mode = "async" as const;
  readonly configSchema = MockHITLExecutor.schema;
  readonly outputSchema = MockHITLExecutor.outSchema;

  /** Store the generated requestId so the test can use it */
  lastRequestId: string | null = null;

  protected async execute(
    config: z.infer<typeof MockHITLExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    meta: import("../types").ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof MockHITLExecutor.outSchema>>> {
    // Create a real approval request in the DB so resumeFromApprovalResolution can find it
    const requestId = crypto.randomUUID();
    this.lastRequestId = requestId;

    this.deps.db.createApprovalRequest({
      id: requestId,
      title: config.title,
      questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
      approvers: { policy: "any" as const },
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
    });

    return {
      status: "success",
      async: true,
      waitFor: "approval.resolved",
      correlationId: requestId,
    } as unknown as ExecutorResult<z.infer<typeof MockHITLExecutor.outSchema>>;
  }
}

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

// ─── Helpers ──────────────────────────────────────────────────

import * as db from "../be/db";

const mockDeps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (t: string) => t,
};

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

function makeWorkflow(def: WorkflowDefinition): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
    name: `test-hitl-routing-${workflowCounter}-${Date.now()}`,
    definition: def,
  });
  createdWorkflowIds.push(workflow.id);
  return workflow;
}

/**
 * Helper: creates a workflow with a HITL node that has port-based routing,
 * starts it, waits for it to go async, then emits an approval event.
 * Returns the run ID and step details for verification.
 */
async function runHITLWorkflow(
  approvalStatus: "approved" | "rejected" | "timeout",
  eventBus: InProcessEventBus,
  registry: ExecutorRegistry,
) {
  const def: WorkflowDefinition = {
    nodes: [
      { id: "start", type: "echo", config: { message: "begin" }, next: "review" },
      {
        id: "review",
        type: "mock-hitl",
        config: { title: "Review deployment" },
        next: {
          approved: "deploy",
          rejected: "generate-question",
          timeout: "notify-timeout",
        },
      },
      { id: "deploy", type: "echo", config: { message: "deploying" } },
      { id: "generate-question", type: "echo", config: { message: "generating question" } },
      { id: "notify-timeout", type: "echo", config: { message: "timed out" } },
    ],
  };

  const workflow = makeWorkflow(def);
  const runId = await startWorkflowExecution(workflow, {}, registry);

  // At this point, "start" has completed and "review" is waiting
  const run = getWorkflowRun(runId);
  expect(run!.status).toBe("waiting");

  const steps = getWorkflowRunStepsByRunId(runId);
  const reviewStep = steps.find((s) => s.nodeId === "review");
  expect(reviewStep).toBeDefined();
  expect(reviewStep!.status).toBe("waiting");

  // Get the mock HITL executor's requestId
  const hitlExecutor = registry.get("mock-hitl") as MockHITLExecutor;
  const requestId = hitlExecutor.lastRequestId!;
  expect(requestId).toBeTruthy();

  // Emit approval.resolved event — this triggers resumeFromApprovalResolution
  // Use a small delay to let the event handler finish
  const resumePromise = new Promise<void>((resolve) => {
    // Give the event handler time to run walkGraph
    setTimeout(resolve, 200);
  });

  eventBus.emit("approval.resolved", {
    requestId,
    status: approvalStatus,
    responses: approvalStatus === "approved" ? { q1: true } : null,
    workflowRunId: runId,
    workflowRunStepId: reviewStep!.id,
  });

  await resumePromise;

  return { runId, workflow };
}

// ─── Tests ────────────────────────────────────────────────────

describe("HITL port-based routing", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    for (const id of createdWorkflowIds) {
      try {
        deleteWorkflow(id);
      } catch {
        // Already deleted
      }
    }
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  test("approved → routes to 'approved' port successor (deploy)", async () => {
    const eventBus = new InProcessEventBus();
    const registry = new ExecutorRegistry();
    registry.register(new MockHITLExecutor({ ...mockDeps, eventBus }));
    registry.register(new EchoExecutor({ ...mockDeps, eventBus }));
    setupWorkflowResumeListener(eventBus, registry);

    const { runId } = await runHITLWorkflow("approved", eventBus, registry);

    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");

    const steps = getWorkflowRunStepsByRunId(runId);
    const stepNodeIds = steps.map((s) => s.nodeId);

    // Should have: start, review, deploy
    expect(stepNodeIds).toContain("start");
    expect(stepNodeIds).toContain("review");
    expect(stepNodeIds).toContain("deploy");

    // Should NOT have the rejected or timeout paths
    expect(stepNodeIds).not.toContain("generate-question");
    expect(stepNodeIds).not.toContain("notify-timeout");
  });

  test("rejected → routes to 'rejected' port successor (generate-question), NOT 'deploy'", async () => {
    const eventBus = new InProcessEventBus();
    const registry = new ExecutorRegistry();
    registry.register(new MockHITLExecutor({ ...mockDeps, eventBus }));
    registry.register(new EchoExecutor({ ...mockDeps, eventBus }));
    setupWorkflowResumeListener(eventBus, registry);

    const { runId } = await runHITLWorkflow("rejected", eventBus, registry);

    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");

    const steps = getWorkflowRunStepsByRunId(runId);
    const stepNodeIds = steps.map((s) => s.nodeId);

    // Should have: start, review, generate-question
    expect(stepNodeIds).toContain("start");
    expect(stepNodeIds).toContain("review");
    expect(stepNodeIds).toContain("generate-question");

    // Should NOT have the approved or timeout paths
    expect(stepNodeIds).not.toContain("deploy");
    expect(stepNodeIds).not.toContain("notify-timeout");
  });

  test("timeout → routes to 'timeout' port successor (notify-timeout)", async () => {
    const eventBus = new InProcessEventBus();
    const registry = new ExecutorRegistry();
    registry.register(new MockHITLExecutor({ ...mockDeps, eventBus }));
    registry.register(new EchoExecutor({ ...mockDeps, eventBus }));
    setupWorkflowResumeListener(eventBus, registry);

    const { runId } = await runHITLWorkflow("timeout", eventBus, registry);

    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");

    const steps = getWorkflowRunStepsByRunId(runId);
    const stepNodeIds = steps.map((s) => s.nodeId);

    // Should have: start, review, notify-timeout
    expect(stepNodeIds).toContain("start");
    expect(stepNodeIds).toContain("review");
    expect(stepNodeIds).toContain("notify-timeout");

    // Should NOT have the approved or rejected paths
    expect(stepNodeIds).not.toContain("deploy");
    expect(stepNodeIds).not.toContain("generate-question");
  });

  test("loop: rejected → loops back to generate-question → review again → approved → deploy", async () => {
    const eventBus = new InProcessEventBus();
    const registry = new ExecutorRegistry();
    const hitlExecutor = new MockHITLExecutor({ ...mockDeps, eventBus });
    registry.register(hitlExecutor);
    registry.register(new EchoExecutor({ ...mockDeps, eventBus }));
    setupWorkflowResumeListener(eventBus, registry);

    // Workflow with a loop: start → generate → review → (rejected) → generate → review → (approved) → deploy
    // Note: generate-question needs a separate entry point (start) because it's
    // also a back-edge target from review-question, so findEntryNodes won't pick it up.
    const def: WorkflowDefinition = {
      nodes: [
        { id: "start", type: "echo", config: { message: "begin" }, next: "generate-question" },
        {
          id: "generate-question",
          type: "echo",
          config: { message: "generating" },
          next: "review-question",
        },
        {
          id: "review-question",
          type: "mock-hitl",
          config: { title: "Review the question" },
          next: {
            approved: "success",
            rejected: "generate-question",
          },
        },
        { id: "success", type: "echo", config: { message: "done" } },
      ],
    };

    const workflow = makeWorkflow(def);
    const runId = await startWorkflowExecution(workflow, {}, registry);

    // After start: generate-question completed, review-question is waiting
    let run = getWorkflowRun(runId);
    expect(run!.status).toBe("waiting");

    let steps = getWorkflowRunStepsByRunId(runId);
    expect(steps).toHaveLength(3); // start + generate-question + review-question
    const reviewStep1 = steps.find((s) => s.nodeId === "review-question");
    expect(reviewStep1!.status).toBe("waiting");

    const requestId1 = hitlExecutor.lastRequestId!;

    // REJECT — should loop back to generate-question
    const reject1Promise = new Promise<void>((resolve) => setTimeout(resolve, 200));
    eventBus.emit("approval.resolved", {
      requestId: requestId1,
      status: "rejected",
      responses: null,
      workflowRunId: runId,
      workflowRunStepId: reviewStep1!.id,
    });
    await reject1Promise;

    // After rejection: generate-question should have re-executed (2nd time),
    // and review-question should be waiting again (2nd time)
    run = getWorkflowRun(runId);
    expect(run!.status).toBe("waiting");

    steps = getWorkflowRunStepsByRunId(runId);
    // Should have: start, generate-question(1), review-question(1), generate-question(2), review-question(2)
    expect(steps).toHaveLength(5);

    const generateSteps = steps.filter((s) => s.nodeId === "generate-question");
    expect(generateSteps).toHaveLength(2); // Two iterations

    const reviewSteps = steps.filter((s) => s.nodeId === "review-question");
    expect(reviewSteps).toHaveLength(2); // Two iterations

    const reviewStep2 = reviewSteps.find((s) => s.status === "waiting");
    expect(reviewStep2).toBeDefined();

    const requestId2 = hitlExecutor.lastRequestId!;
    expect(requestId2).not.toBe(requestId1); // Different request

    // APPROVE — should go to success
    const approve2Promise = new Promise<void>((resolve) => setTimeout(resolve, 200));
    eventBus.emit("approval.resolved", {
      requestId: requestId2,
      status: "approved",
      responses: { q1: true },
      workflowRunId: runId,
      workflowRunStepId: reviewStep2!.id,
    });
    await approve2Promise;

    // Final state: completed with all steps
    run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");

    steps = getWorkflowRunStepsByRunId(runId);
    // start + generate(1) + review(1) + generate(2) + review(2) + success = 6 steps
    expect(steps).toHaveLength(6);

    const successSteps = steps.filter((s) => s.nodeId === "success");
    expect(successSteps).toHaveLength(1);
    expect(successSteps[0]!.status).toBe("completed");
  });
});
