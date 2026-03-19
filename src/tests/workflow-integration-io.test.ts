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
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution, TriggerSchemaError } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";

const TEST_DB_PATH = "./test-workflow-integration-io.sqlite";

// ─── Test Executors ──────────────────────────────────────────

/** Simple executor that echoes its config message. */
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

/** Branch executor that evaluates a condition on the global context. */
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

/** Passthrough executor — returns whatever data is passed in config. */
class PassthroughExecutor extends BaseExecutor<
  typeof PassthroughExecutor.schema,
  typeof PassthroughExecutor.outSchema
> {
  static readonly schema = z.object({ data: z.unknown() });
  static readonly outSchema = z.record(z.string(), z.unknown());

  readonly type = "passthrough";
  readonly mode = "instant" as const;
  readonly configSchema = PassthroughExecutor.schema;
  readonly outputSchema = PassthroughExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof PassthroughExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof PassthroughExecutor.outSchema>>> {
    return {
      status: "success",
      output: (config.data ?? {}) as Record<string, unknown>,
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
  registry.register(new BranchExecutor(mockDeps));
  registry.register(new PassthroughExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

function makeWorkflow(def: WorkflowDefinition, overrides?: Partial<Workflow>): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
    name: overrides?.name || `test-integration-io-${workflowCounter}-${Date.now()}`,
    definition: def,
    triggers: overrides?.triggers,
    cooldown: overrides?.cooldown,
    input: overrides?.input,
    triggerSchema: overrides?.triggerSchema,
  });
  createdWorkflowIds.push(workflow.id);
  return { ...workflow, ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────

describe("Workflow Integration — I/O Schemas, Convergence, TriggerSchema (Phase 6)", () => {
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

  // ─── Comprehensive Multi-Feature Workflow ──────────────────

  describe("Full pipeline: triggerSchema + inputs + inputSchema + convergence + chained data flow", () => {
    // Workflow topology:
    //
    //   [A: echo] ──> [B: property-match] ──true──> [C: echo]
    //        │                  │                       │
    //        │                false                     │
    //        │                  │                       │
    //        │                  v                       │
    //        │             [B_alt: echo]                │
    //        │                  │                       │
    //        │                  └───────────> [D: echo] <
    //        └──────────────────────────────────────────┘
    //
    // - triggerSchema enforces { repo: string, action: string }
    // - A: inputs from trigger.repo, inputSchema validates repo is string
    // - B: branches based on A.echo containing "main"
    // - C: reached when B takes "true" port (B_alt skipped)
    // - B_alt: reached when B takes "false" port
    // - D: converges from C (or B_alt), chains data from A and C (or B_alt)

    const triggerSchema = {
      type: "object",
      properties: {
        repo: { type: "string" },
        action: { type: "string" },
      },
      required: ["repo", "action"],
    };

    function buildDef(): WorkflowDefinition {
      return {
        nodes: [
          {
            id: "A",
            type: "echo",
            inputs: { repo: "trigger.repo" },
            inputSchema: {
              type: "object",
              properties: { repo: { type: "string" } },
              required: ["repo"],
            },
            config: { message: "repo={{repo}}" },
            next: "B",
          },
          {
            id: "B",
            type: "property-match",
            config: {
              conditions: [{ field: "A.echo", op: "eq", value: "repo=main-app" }],
            },
            next: { true: "C", false: "B_alt" },
          },
          {
            id: "C",
            type: "echo",
            inputs: { fromA: "A.echo" },
            config: { message: "C: A said {{fromA}}" },
            next: "D",
          },
          {
            id: "B_alt",
            type: "echo",
            inputs: { fromA: "A.echo" },
            config: { message: "B_alt: A said {{fromA}}" },
            next: "D",
          },
          {
            id: "D",
            type: "echo",
            inputs: { fromA: "A.echo", action: "trigger.action" },
            config: { message: "D: fromA={{fromA}} action={{action}}" },
          },
        ],
      };
    }

    test("triggerSchema rejects invalid payload (missing required field)", async () => {
      const registry = createTestRegistry();
      const def = buildDef();
      const workflow = makeWorkflow(def, { triggerSchema });

      // Missing "action" field
      await expect(
        startWorkflowExecution(workflow, { repo: "main-app" }, registry),
      ).rejects.toThrow(TriggerSchemaError);

      try {
        await startWorkflowExecution(workflow, { repo: "main-app" }, registry);
      } catch (err) {
        expect(err).toBeInstanceOf(TriggerSchemaError);
        expect((err as TriggerSchemaError).validationErrors.length).toBeGreaterThan(0);
        expect((err as TriggerSchemaError).message).toContain("action");
      }
    });

    test("triggerSchema rejects wrong type", async () => {
      const registry = createTestRegistry();
      const def = buildDef();
      const workflow = makeWorkflow(def, { triggerSchema });

      // repo should be string but passing number
      await expect(
        startWorkflowExecution(workflow, { repo: 123, action: "push" }, registry),
      ).rejects.toThrow(TriggerSchemaError);
    });

    test("triggerSchema accepts valid payload — true branch executes", async () => {
      const registry = createTestRegistry();
      const def = buildDef();
      const workflow = makeWorkflow(def, { triggerSchema });

      const runId = await startWorkflowExecution(
        workflow,
        { repo: "main-app", action: "push" },
        registry,
      );

      const run = getWorkflowRun(runId);
      expect(run).not.toBeNull();
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;

      // A should have echoed the repo from trigger
      expect(ctx.A).toEqual({ echo: "repo=main-app" });

      // B should have matched (A.echo == "repo=main-app") and taken true port
      expect((ctx.B as Record<string, unknown>).passed).toBe(true);

      // C should have run (true branch)
      expect(ctx.C).toEqual({ echo: "C: A said repo=main-app" });

      // D should have combined data from A and trigger
      expect(ctx.D).toEqual({ echo: "D: fromA=repo=main-app action=push" });

      // B_alt should NOT have run
      expect(ctx.B_alt).toBeUndefined();

      // Verify step records
      const steps = getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).toContain("A");
      expect(nodeIds).toContain("B");
      expect(nodeIds).toContain("C");
      expect(nodeIds).toContain("D");
      expect(nodeIds).not.toContain("B_alt");
    });

    test("false branch executes when condition fails — convergence works", async () => {
      const registry = createTestRegistry();
      const def = buildDef();
      const workflow = makeWorkflow(def, { triggerSchema });

      const runId = await startWorkflowExecution(
        workflow,
        { repo: "other-repo", action: "deploy" },
        registry,
      );

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;

      // A echoes the different repo
      expect(ctx.A).toEqual({ echo: "repo=other-repo" });

      // B takes false (A.echo != "repo=main-app")
      expect((ctx.B as Record<string, unknown>).passed).toBe(false);

      // B_alt should have run (false branch)
      expect(ctx.B_alt).toEqual({ echo: "B_alt: A said repo=other-repo" });

      // C should NOT have run
      expect(ctx.C).toBeUndefined();

      // D should still have run (convergence from B_alt)
      expect(ctx.D).toEqual({ echo: "D: fromA=repo=other-repo action=deploy" });

      const steps = getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).toContain("A");
      expect(nodeIds).toContain("B");
      expect(nodeIds).not.toContain("C");
      expect(nodeIds).toContain("B_alt");
      expect(nodeIds).toContain("D");
    });
  });

  // ─── InputSchema Validation in Chained Pipeline ─────────────

  describe("inputSchema validation failure halts pipeline", () => {
    test("node with inputSchema fails when resolved input has wrong type", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "source",
            type: "passthrough",
            config: { data: { count: "not-a-number" } },
            next: "consumer",
          },
          {
            id: "consumer",
            type: "echo",
            inputs: { count: "source.count" },
            inputSchema: {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
            },
            config: { message: "count={{count}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Input schema validation failed");
      expect(run!.error).toContain("count");

      // consumer step should not have completed
      const steps = getWorkflowRunStepsByRunId(runId);
      const consumerStep = steps.find((s) => s.nodeId === "consumer");
      expect(consumerStep).toBeDefined();
      expect(consumerStep!.status).toBe("failed");
    });
  });

  // ─── OutputSchema Validation in Pipeline ─────────────────────

  describe("outputSchema validation in pipeline", () => {
    test("output schema failure prevents downstream execution", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "producer",
            type: "passthrough",
            config: { data: { value: "string-not-number" } },
            outputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
            next: "consumer",
          },
          {
            id: "consumer",
            type: "echo",
            config: { message: "should not run" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Output schema validation failed");

      const steps = getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).not.toContain("consumer");
    });
  });

  // ─── Unresolved Token Diagnostics ──────────────────────────

  describe("Unresolved token diagnostics", () => {
    test("unresolved tokens stored in step diagnostics", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            inputs: { typo: "trigger.nonexistent_field" },
            config: { message: "val={{typo}} other={{missing_var}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { actualField: "data" }, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(1);

      // Check that diagnostics contain unresolved tokens
      const step = steps[0]!;
      if (step.diagnostics) {
        const diag = JSON.parse(step.diagnostics as string);
        expect(diag.unresolvedTokens).toBeDefined();
        expect(diag.unresolvedTokens.length).toBeGreaterThan(0);
        // "missing_var" should be unresolved since it's not in local context
        expect(diag.unresolvedTokens).toContain("missing_var");
      }
    });
  });

  // ─── Local Context Isolation ───────────────────────────────

  describe("Local context isolation — nodes only see declared inputs", () => {
    test("node without inputs mapping cannot access upstream node outputs", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            config: { message: "secret" },
            next: "B",
          },
          {
            id: "B",
            type: "echo",
            // No inputs — should NOT be able to see A's output
            config: { message: "A.echo={{A.echo}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      // B should have an unresolved token — A.echo not in local context
      expect(ctx.B).toEqual({ echo: "A.echo=" });
    });

    test("node with explicit inputs gets only declared values", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "passthrough",
            config: { data: { x: 1, y: 2 } },
            next: "B",
          },
          {
            id: "B",
            type: "echo",
            inputs: { xVal: "A.x" },
            // Can access xVal but not A.y directly
            config: { message: "x={{xVal}} y={{A.y}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      // xVal resolves to 1, A.y is unresolved (not in local context)
      expect(ctx.B).toEqual({ echo: "x=1 y=" });
    });
  });

  // ─── Trigger and Input Built-in Sources ────────────────────

  describe("Built-in sources (trigger, input) always available", () => {
    test("trigger data accessible even with inputs declared", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            inputs: { custom: "trigger.name" },
            config: { message: "custom={{custom}} direct={{trigger.name}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { name: "test" }, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      // Both custom and direct trigger access should resolve
      expect(ctx.step1).toEqual({ echo: "custom=test direct=test" });
    });

    test("workflow-level input accessible in nodes", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            config: { message: "env={{input.API_KEY}}" },
          },
        ],
      };

      // Set env var for input resolution
      process.env.TEST_INTEG_API_KEY = "secret123";
      const workflow = makeWorkflow(def, {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var syntax
        input: { API_KEY: "${TEST_INTEG_API_KEY}" },
      });
      const runId = await startWorkflowExecution(workflow, {}, registry);
      delete process.env.TEST_INTEG_API_KEY;

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      expect(ctx.step1).toEqual({ echo: "env=secret123" });
    });
  });

  // ─── Static Data Flow Validation (validateDefinition) ──────

  describe("Static data flow validation — validateDefinition", () => {
    test("valid pipeline with upstream inputs passes", () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          { id: "A", type: "echo", config: { message: "hi" }, next: "B" },
          {
            id: "B",
            type: "echo",
            inputs: { fromA: "A.echo" },
            config: { message: "{{fromA}}" },
            next: "C",
          },
          {
            id: "C",
            type: "echo",
            inputs: { fromA: "A.echo", fromB: "B.echo" },
            config: { message: "{{fromA}} {{fromB}}" },
          },
        ],
      };

      const result = validateDefinition(def, registry);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("input referencing non-existent node fails validation", () => {
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            inputs: { data: "ghost.output" },
            config: { message: "{{data}}" },
          },
        ],
      };

      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("ghost") && e.includes("non-existent"))).toBe(
        true,
      );
    });

    test("input referencing downstream node fails validation", () => {
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            inputs: { data: "B.echo" },
            config: { message: "{{data}}" },
            next: "B",
          },
          { id: "B", type: "echo", config: { message: "hi" } },
        ],
      };

      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("B") && e.includes("not upstream"))).toBe(true);
    });

    test("input referencing trigger/input (built-in) passes validation", () => {
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            inputs: { repo: "trigger.repo", key: "input.API_KEY" },
            config: { message: "{{repo}} {{key}}" },
          },
        ],
      };

      const result = validateDefinition(def);
      expect(result.valid).toBe(true);
    });

    test("self-referencing node input fails validation", () => {
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            inputs: { self: "A.echo" },
            config: { message: "{{self}}" },
          },
        ],
      };

      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("A") && e.includes("not upstream"))).toBe(true);
    });
  });

  // ─── No triggerSchema — backward compat ────────────────────

  describe("No triggerSchema — any payload accepted (backward compat)", () => {
    test("workflow without triggerSchema accepts any trigger data", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            config: { message: "hello" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      // No triggerSchema — arbitrary data should work
      const runId = await startWorkflowExecution(
        workflow,
        { anything: "goes", nested: { deep: true } },
        registry,
      );

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");
    });
  });

  // ─── Deep Interpolation in Nested Config ───────────────────

  describe("Deep interpolation — arrays and nested objects in config", () => {
    test("interpolation works inside arrays and nested objects", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "passthrough",
            inputs: { repo: "trigger.repo" },
            config: {
              data: {
                tags: ["{{repo}}", "fixed-tag"],
                metadata: {
                  source: "{{trigger.source}}",
                  nested: {
                    level: "deep-{{repo}}",
                  },
                },
              },
            },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(
        workflow,
        { repo: "my-repo", source: "webhook" },
        registry,
      );

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      const output = ctx.step1 as Record<string, unknown>;
      expect(output.tags).toEqual(["my-repo", "fixed-tag"]);
      expect((output.metadata as Record<string, unknown>).source).toBe("webhook");
      expect(
        ((output.metadata as Record<string, unknown>).nested as Record<string, unknown>).level,
      ).toBe("deep-my-repo");
    });
  });

  // ─── Complex Diamond with Data Flow ────────────────────────

  describe("Diamond convergence with chained data flow", () => {
    test("A fans out to B and C, both converge to D which reads from both", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            config: { message: "start" },
            next: { x: "B", y: "C" },
          },
          {
            id: "B",
            type: "echo",
            inputs: { fromA: "A.echo" },
            config: { message: "B:{{fromA}}" },
            next: "D",
          },
          {
            id: "C",
            type: "echo",
            inputs: { fromA: "A.echo" },
            config: { message: "C:{{fromA}}" },
            next: "D",
          },
          {
            id: "D",
            type: "echo",
            inputs: { fromB: "B.echo", fromC: "C.echo" },
            config: { message: "D got {{fromB}} and {{fromC}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      expect(ctx.A).toEqual({ echo: "start" });
      expect(ctx.B).toEqual({ echo: "B:start" });
      expect(ctx.C).toEqual({ echo: "C:start" });
      expect(ctx.D).toEqual({ echo: "D got B:start and C:start" });

      // All 4 nodes should have steps
      const steps = getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(4);
      expect(steps.every((s) => s.status === "completed")).toBe(true);
    });
  });

  // ─── MAX_ITERATIONS Guard ─────────────────────────────────

  describe("MAX_ITERATIONS counts individual node executions", () => {
    test("parallel fan-out counts all nodes, not just batches", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "root",
            type: "echo",
            config: { message: "go" },
            next: { a: "p1", b: "p2", c: "p3" },
          },
          { id: "p1", type: "echo", config: { message: "1" } },
          { id: "p2", type: "echo", config: { message: "2" } },
          { id: "p3", type: "echo", config: { message: "3" } },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      // Should have 4 steps (root + 3 parallel)
      const steps = getWorkflowRunStepsByRunId(runId);
      expect(steps).toHaveLength(4);
    });
  });

  // ─── nextPort Persistence for Recovery ─────────────────────

  describe("nextPort stored in step records", () => {
    test("branch step persists nextPort for recovery reconstruction", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "branch",
            type: "property-match",
            config: {
              conditions: [{ field: "trigger.mode", op: "eq", value: "fast" }],
            },
            next: { true: "fast_path", false: "slow_path" },
          },
          { id: "fast_path", type: "echo", config: { message: "fast" } },
          { id: "slow_path", type: "echo", config: { message: "slow" } },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { mode: "fast" }, registry);

      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
      const branchStep = steps.find((s) => s.nodeId === "branch");
      expect(branchStep).toBeDefined();
      expect(branchStep!.nextPort).toBe("true");

      // Only fast_path should have executed
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).toContain("fast_path");
      expect(nodeIds).not.toContain("slow_path");
    });
  });
});
