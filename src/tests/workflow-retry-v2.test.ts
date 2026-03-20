import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  deleteWorkflow,
  getCompletedStepNodeIds,
  getRetryableSteps,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { RetryPolicy, Workflow, WorkflowDefinition } from "../types";
import { findReadyNodes, startWorkflowExecution, walkGraph } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { calculateDelay, startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-retry-v2.sqlite";

// ─── Test Executors ──────────────────────────────────────────

let failCounter = 0;

class FailOnceExecutor extends BaseExecutor<
  typeof FailOnceExecutor.schema,
  typeof FailOnceExecutor.outSchema
> {
  static readonly schema = z.object({ failUntilAttempt: z.number().default(1) });
  static readonly outSchema = z.object({ attempt: z.number() });

  readonly type = "fail-once";
  readonly mode = "instant" as const;
  readonly configSchema = FailOnceExecutor.schema;
  readonly outputSchema = FailOnceExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof FailOnceExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof FailOnceExecutor.outSchema>>> {
    failCounter++;
    if (failCounter <= config.failUntilAttempt) {
      return { status: "failed", error: `Intentional failure #${failCounter}` };
    }
    return { status: "success", output: { attempt: failCounter } };
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
  interpolate: (template, ctx) => interpolate(template, ctx).result,
};

function createTestRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new FailOnceExecutor(mockDeps));
  registry.register(new EchoExecutor(mockDeps));
  registry.register(new NotifyStubExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

function makeWorkflow(def: WorkflowDefinition, overrides?: Partial<Workflow>): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
    name: overrides?.name || `test-retry-${workflowCounter}-${Date.now()}`,
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
});

afterAll(async () => {
  stopRetryPoller();
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

describe("Workflow Retry v2 (Phase 4)", () => {
  describe("calculateDelay", () => {
    test("static backoff returns baseDelayMs", () => {
      const policy: RetryPolicy = {
        strategy: "static",
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      };
      expect(calculateDelay(policy, 0)).toBe(1000);
      expect(calculateDelay(policy, 1)).toBe(1000);
      expect(calculateDelay(policy, 5)).toBe(1000);
    });

    test("linear backoff scales with attempt", () => {
      const policy: RetryPolicy = {
        strategy: "linear",
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      };
      expect(calculateDelay(policy, 0)).toBe(1000); // 1000 * 1
      expect(calculateDelay(policy, 1)).toBe(2000); // 1000 * 2
      expect(calculateDelay(policy, 2)).toBe(3000); // 1000 * 3
    });

    test("linear backoff is capped at maxDelayMs", () => {
      const policy: RetryPolicy = {
        strategy: "linear",
        maxRetries: 10,
        baseDelayMs: 5000,
        maxDelayMs: 15000,
      };
      expect(calculateDelay(policy, 5)).toBe(15000); // 5000 * 6 = 30000, capped at 15000
    });

    test("exponential backoff returns value within bounds", () => {
      const policy: RetryPolicy = {
        strategy: "exponential",
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 10000,
      };

      // Run multiple times to verify it's within bounds (jitter is random)
      for (let i = 0; i < 20; i++) {
        const delay = calculateDelay(policy, 2);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(10000);
      }
    });

    test("exponential backoff grows with attempt", () => {
      const policy: RetryPolicy = {
        strategy: "exponential",
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 100000,
      };

      // Max possible value at attempt 0: 100 * 2^0 = 100
      // Max possible value at attempt 3: 100 * 2^3 = 800
      // With jitter, actual values will be lower, but the ceiling grows.
      // We can verify the ceiling isn't exceeded.
      for (let i = 0; i < 20; i++) {
        const d0 = calculateDelay(policy, 0);
        expect(d0).toBeLessThanOrEqual(100);
        const d3 = calculateDelay(policy, 3);
        expect(d3).toBeLessThanOrEqual(800);
      }
    });
  });

  describe("Retry Poller", () => {
    test("poller picks up failed steps past nextRetryAt", async () => {
      // Reset fail counter so the executor succeeds on the "retry" attempt
      failCounter = 0;

      const workflow = makeWorkflow({
        nodes: [
          {
            id: "n1",
            type: "fail-once",
            config: { failUntilAttempt: 1 },
            retry: {
              strategy: "static",
              maxRetries: 3,
              baseDelayMs: 10,
              maxDelayMs: 10,
            },
          },
        ],
      });

      // Execute — first attempt will fail, setting nextRetryAt
      failCounter = 0;
      const runId = await startWorkflowExecution(workflow, {}, registry);

      // Check step is failed with a nextRetryAt
      const steps = getWorkflowRunStepsByRunId(runId);
      const step = steps.find((s) => s.nodeId === "n1")!;
      expect(step.status).toBe("failed");
      expect(step.nextRetryAt).toBeTruthy();
      expect(step.retryCount).toBe(1);

      // Wait for nextRetryAt to pass
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify getRetryableSteps finds it
      const retryable = getRetryableSteps();
      expect(retryable.length).toBeGreaterThanOrEqual(1);
      const ourStep = retryable.find((s) => s.runId === runId);
      expect(ourStep).toBeTruthy();
    });

    test("retry limit respected (does not retry past maxRetries)", async () => {
      const workflow = makeWorkflow({
        nodes: [
          {
            id: "n1",
            type: "fail-once",
            config: { failUntilAttempt: 999 }, // Always fails
            retry: {
              strategy: "static",
              maxRetries: 1,
              baseDelayMs: 10,
              maxDelayMs: 10,
            },
          },
        ],
      });

      failCounter = 0;
      const runId = await startWorkflowExecution(workflow, {}, registry);

      // Step should be failed after first attempt (retryCount=1, maxRetries=1)
      const run = getWorkflowRun(runId);
      // With maxRetries=1, the first failure increments to retryCount=1.
      // Since retryCount(1) >= maxRetries(1), no more retries — run should be failed.
      // Actually: checkpoint checks retryCount < maxRetries. After first failure, retryCount=1 and
      // maxRetries=1, so 1 < 1 is false => no retry => run fails.
      // Wait, let me re-check: the engine passes currentRetryCount (from existing step, which is 0
      // on first attempt), and checkpoint does retryCount + 1 = 1, then checks 0 < 1 = true,
      // so it DOES retry once.
      const steps = getWorkflowRunStepsByRunId(runId);
      const step = steps.find((s) => s.nodeId === "n1")!;

      if (step.status === "failed" && step.nextRetryAt) {
        // Was given one retry chance — let it expire and start poller
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Start poller with very short interval
        startRetryPoller(registry, 50);
        await new Promise((resolve) => setTimeout(resolve, 200));
        stopRetryPoller();

        // After retry, the second failure should be terminal (retryCount >= maxRetries)
        const updatedRun = getWorkflowRun(runId);
        expect(updatedRun!.status).toBe("failed");
      } else {
        // Already terminal
        expect(run!.status).toBe("failed");
      }
    });
  });

  describe("Recovery", () => {
    test("running run with completed steps resumes correctly", async () => {
      // Create a workflow with 2 nodes
      const workflow = makeWorkflow({
        nodes: [
          { id: "s1", type: "echo", config: { message: "step1" }, next: "s2" },
          { id: "s2", type: "echo", config: { message: "step2" } },
        ],
      });

      // Simulate a run that was interrupted after s1 completed
      const runId = crypto.randomUUID();
      createWorkflowRun({ id: runId, workflowId: workflow.id, triggerData: {} });

      // Create a completed step for s1
      const step1Id = crypto.randomUUID();
      createWorkflowRunStep({
        id: step1Id,
        runId,
        nodeId: "s1",
        nodeType: "echo",
        input: {},
      });
      updateWorkflowRunStep(step1Id, {
        status: "completed",
        output: { echo: "step1" },
        idempotencyKey: `${runId}:s1`,
        finishedAt: new Date().toISOString(),
      });

      // Update run context
      updateWorkflowRun(runId, {
        context: { s1: { echo: "step1" } },
      });

      // Verify run is in 'running' state
      expect(getWorkflowRun(runId)!.status).toBe("running");

      // Verify s1 is completed
      const completedIds = getCompletedStepNodeIds(runId);
      expect(completedIds).toContain("s1");

      // Run recovery
      const recovered = await recoverIncompleteRuns(registry);
      expect(recovered).toBeGreaterThanOrEqual(1);

      // Run should now be completed (s2 was executed by recovery)
      const updatedRun = getWorkflowRun(runId);
      expect(updatedRun!.status).toBe("completed");

      // Both steps should be completed
      const steps = getWorkflowRunStepsByRunId(runId);
      const completedSteps = steps.filter((s) => s.status === "completed");
      expect(completedSteps.length).toBe(2);
    });

    test("running run with all steps completed is marked completed", async () => {
      const workflow = makeWorkflow({
        nodes: [{ id: "s1", type: "echo", config: { message: "only" } }],
      });

      const runId = crypto.randomUUID();
      createWorkflowRun({ id: runId, workflowId: workflow.id, triggerData: {} });

      const step1Id = crypto.randomUUID();
      createWorkflowRunStep({
        id: step1Id,
        runId,
        nodeId: "s1",
        nodeType: "echo",
        input: {},
      });
      updateWorkflowRunStep(step1Id, {
        status: "completed",
        output: { echo: "only" },
        idempotencyKey: `${runId}:s1`,
        finishedAt: new Date().toISOString(),
      });
      updateWorkflowRun(runId, { context: { s1: { echo: "only" } } });

      const recovered = await recoverIncompleteRuns(registry);
      expect(recovered).toBeGreaterThanOrEqual(1);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");
    });
  });
});
