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
import { findReadyNodes, startWorkflowExecution, walkGraph } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { resolveInputs } from "../workflows/input";

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
function makeWorkflow(def: WorkflowDefinition, overrides?: Partial<Workflow>): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { test: true }, registry);

      const run = getWorkflowRun(runId);
      expect(run).not.toBeNull();
      expect(run!.status).toBe("completed");

      // Verify context accumulated
      expect(run!.context).toBeDefined();
      const ctx = run!.context as Record<string, unknown>;
      expect(ctx.step1).toEqual({ echo: "hello" });
      expect(ctx.step2).toEqual({ echo: "world" });
      expect(ctx.step3).toEqual({ echo: "done" });

      // Verify 3 steps created
      const steps = getWorkflowRunStepsByRunId(runId);
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
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
      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      // Now walk the graph again with the same runId — steps should be skipped
      const ctx: Record<string, unknown> = { trigger: {} };
      const entryNodes = def.nodes.filter((n) => n.id === "a");
      await walkGraph(def, runId, ctx, entryNodes, registry, workflow.id);

      // Should still have only 2 steps (no duplicates)
      const steps = getWorkflowRunStepsByRunId(runId);
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
          // 60s delay should exceed the 30s default timeout
          { id: "slow", type: "slow", config: { delayMs: 60_000 } },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("timed out");
    }, 35_000); // Allow test up to 35s
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(2);
    });

    test("validation halt (mustPass) fails the run", async () => {
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Validation failed");

      const steps = getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).not.toContain("step2");
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
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
      const workflow = makeWorkflow(def, { cooldown: { hours: 1 } });

      // Create a successful run that just finished
      const runId = crypto.randomUUID();
      createWorkflowRun({ id: runId, workflowId: workflow.id });
      updateWorkflowRun(runId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });

      // Should skip — within 1 hour cooldown
      const skip = shouldSkipCooldown(workflow.id, { hours: 1 });
      expect(skip).toBe(true);

      // Should not skip — with 0 second cooldown
      const noSkip = shouldSkipCooldown(workflow.id, { seconds: 0 });
      expect(noSkip).toBe(false);
    });

    test("startWorkflowExecution creates skipped run on cooldown", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "echo", config: { message: "hi" } }],
      };
      const workflow = makeWorkflow(def, { cooldown: { hours: 1 } });

      // Run the workflow once (should succeed)
      const run1Id = await startWorkflowExecution(workflow, {}, registry);
      const run1 = getWorkflowRun(run1Id);
      expect(run1!.status).toBe("completed");

      // Run again — should be skipped due to cooldown
      const run2Id = await startWorkflowExecution(workflow, {}, registry);
      const run2 = getWorkflowRun(run2Id);
      expect(run2!.status).toBe("skipped");
      expect(run2!.error).toBe("cooldown");
    });
  });

  // ─── Input Resolution ─────────────────────────────────────

  describe("Input resolution", () => {
    test("resolves environment variables", () => {
      process.env.TEST_WORKFLOW_VAR = "resolved_value";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var syntax
      const result = resolveInputs({ myVar: "${TEST_WORKFLOW_VAR}" });
      expect(result.myVar).toBe("resolved_value");
      delete process.env.TEST_WORKFLOW_VAR;
    });

    test("passes through literal strings", () => {
      const result = resolveInputs({ name: "literal value" });
      expect(result.name).toBe("literal value");
    });

    test("throws on missing environment variable", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var syntax
      expect(() => resolveInputs({ bad: "${NONEXISTENT_WORKFLOW_VAR_12345}" })).toThrow("not set");
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");

      const steps = getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).not.toContain("after");
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

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");
      expect((run!.context as Record<string, unknown>).second).toEqual({
        echo: "got: hello",
      });
    });
  });
});
