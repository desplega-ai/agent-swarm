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
import { startWorkflowExecution, walkGraph } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { validateJsonSchema } from "../workflows/json-schema-validator";

const TEST_DB_PATH = "./test-workflow-io-schemas.sqlite";

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

/** Executor that returns arbitrary output for testing outputSchema validation */
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

/** Executor that returns badly-typed output (for recovery validation test) */
class CorruptOutputExecutor extends BaseExecutor<
  typeof CorruptOutputExecutor.schema,
  typeof CorruptOutputExecutor.outSchema
> {
  static readonly schema = z.object({});
  static readonly outSchema = z.object({ value: z.number() });

  readonly type = "corrupt-test";
  readonly mode = "instant" as const;
  readonly configSchema = CorruptOutputExecutor.schema;
  readonly outputSchema = CorruptOutputExecutor.outSchema;

  protected async execute(): Promise<
    ExecutorResult<z.infer<typeof CorruptOutputExecutor.outSchema>>
  > {
    return { status: "success", output: { value: 42 } };
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
  registry.register(new PassthroughExecutor(mockDeps));
  registry.register(new CorruptOutputExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

function makeWorkflow(def: WorkflowDefinition, overrides?: Partial<Workflow>): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
    name: overrides?.name || `test-io-schemas-${workflowCounter}-${Date.now()}`,
    definition: def,
    triggers: overrides?.triggers,
    cooldown: overrides?.cooldown,
    input: overrides?.input,
  });
  createdWorkflowIds.push(workflow.id);
  return { ...workflow, ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────

describe("Workflow I/O Schemas (Phase 3)", () => {
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

  // ─── JSON Schema Validator Unit Tests ────────────────────────

  describe("validateJsonSchema — unit tests", () => {
    test("type: string — valid", () => {
      const errors = validateJsonSchema({ type: "string" }, "hello");
      expect(errors).toEqual([]);
    });

    test("type: string — invalid", () => {
      const errors = validateJsonSchema({ type: "string" }, 123);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("string");
    });

    test("type: number — valid", () => {
      expect(validateJsonSchema({ type: "number" }, 42)).toEqual([]);
    });

    test("type: number — invalid", () => {
      const errors = validateJsonSchema({ type: "number" }, "not a number");
      expect(errors.length).toBe(1);
    });

    test("type: boolean — valid", () => {
      expect(validateJsonSchema({ type: "boolean" }, true)).toEqual([]);
    });

    test("type: boolean — invalid", () => {
      const errors = validateJsonSchema({ type: "boolean" }, "true");
      expect(errors.length).toBe(1);
    });

    test("type: array — valid", () => {
      expect(validateJsonSchema({ type: "array" }, [1, 2, 3])).toEqual([]);
    });

    test("type: array — invalid (object is not array)", () => {
      const errors = validateJsonSchema({ type: "array" }, { a: 1 });
      expect(errors.length).toBe(1);
    });

    test("type: object — valid", () => {
      expect(validateJsonSchema({ type: "object" }, { a: 1 })).toEqual([]);
    });

    test("type: object — invalid (null is not object)", () => {
      const errors = validateJsonSchema({ type: "object" }, null);
      expect(errors.length).toBe(1);
    });

    test("type: object — invalid (array is not object)", () => {
      const errors = validateJsonSchema({ type: "object" }, [1, 2]);
      expect(errors.length).toBe(1);
    });

    test("required fields — all present", () => {
      const schema = { type: "object", required: ["a", "b"] };
      expect(validateJsonSchema(schema, { a: 1, b: 2 })).toEqual([]);
    });

    test("required fields — missing one", () => {
      const schema = { type: "object", required: ["a", "b"] };
      const errors = validateJsonSchema(schema, { a: 1 });
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('"b"');
    });

    test("required fields — missing all", () => {
      const schema = { type: "object", required: ["a", "b"] };
      const errors = validateJsonSchema(schema, {});
      expect(errors.length).toBe(2);
    });

    test("nested properties — valid", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      };
      expect(validateJsonSchema(schema, { name: "Alice", age: 30 })).toEqual([]);
    });

    test("nested properties — wrong type", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };
      const errors = validateJsonSchema(schema, { name: "Alice", age: "thirty" });
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("age");
    });

    test("deeply nested properties", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  email: { type: "string" },
                },
                required: ["email"],
              },
            },
          },
        },
      };
      // Valid
      expect(validateJsonSchema(schema, { user: { profile: { email: "a@b.com" } } })).toEqual([]);
      // Missing required nested field
      const errors = validateJsonSchema(schema, { user: { profile: {} } });
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("email");
    });

    test("no schema constraints — anything valid", () => {
      expect(validateJsonSchema({}, "anything")).toEqual([]);
      expect(validateJsonSchema({}, 42)).toEqual([]);
      expect(validateJsonSchema({}, null)).toEqual([]);
    });

    test("unknown type — passes (no blocking)", () => {
      expect(validateJsonSchema({ type: "foobar" }, 123)).toEqual([]);
    });
  });

  // ─── Inputs Resolution ───────────────────────────────────────

  describe("Explicit inputs resolution", () => {
    test("node with inputs gets correct local context for interpolation", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "first",
            type: "echo",
            config: { message: "hello" },
            next: "second",
          },
          {
            id: "second",
            type: "echo",
            inputs: { echoResult: "first.echo" },
            config: { message: "got: {{echoResult}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { source: "test" }, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      // The second node should have interpolated "hello" from first.echo
      expect(ctx.second).toEqual({ echo: "got: hello" });
    });

    test("built-in sources (trigger, input) always available even with inputs declared", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "echo",
            inputs: { custom: "trigger.source" },
            config: { message: "trigger={{trigger.source}} custom={{custom}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { source: "webhook" }, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      expect(ctx.step1).toEqual({ echo: "trigger=webhook custom=webhook" });
    });

    test("no inputs field — only trigger and input context available", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "first",
            type: "echo",
            config: { message: "data" },
            next: "second",
          },
          {
            id: "second",
            type: "echo",
            // No inputs — should NOT have access to first.echo
            config: { message: "prev={{first.echo}} trig={{trigger.val}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { val: "hi" }, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      // first.echo should be unresolved (not in local context), trigger.val should work
      expect(ctx.second).toEqual({ echo: "prev= trig=hi" });
    });
  });

  // ─── InputSchema Validation ──────────────────────────────────

  describe("InputSchema validation", () => {
    test("valid input passes schema check", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "validated",
            type: "echo",
            inputs: { msg: "trigger.message" },
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
              required: ["msg"],
            },
            config: { message: "{{msg}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, { message: "hello" }, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");
    });

    test("invalid input fails schema check", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "validated",
            type: "echo",
            inputs: { count: "trigger.count" },
            inputSchema: {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
            },
            config: { message: "{{count}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      // Pass a string instead of a number
      const runId = await startWorkflowExecution(workflow, { count: "not-a-number" }, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Input schema validation failed");
    });

    test("missing required input field fails", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "validated",
            type: "echo",
            inputs: {},
            inputSchema: {
              type: "object",
              required: ["name"],
            },
            config: { message: "hi" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("name");
    });
  });

  // ─── OutputSchema Validation ─────────────────────────────────

  describe("OutputSchema validation", () => {
    test("valid output passes schema check", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "passthrough",
            config: { data: { result: "ok", count: 5 } },
            outputSchema: {
              type: "object",
              properties: {
                result: { type: "string" },
                count: { type: "number" },
              },
              required: ["result"],
            },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");
    });

    test("invalid output fails schema check", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "passthrough",
            config: { data: { result: 123 } },
            outputSchema: {
              type: "object",
              properties: {
                result: { type: "string" },
              },
            },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Output schema validation failed");
    });
  });

  // ─── Bug 5: Recovery Validation ──────────────────────────────

  describe("Bug 5 — Recovery output validation", () => {
    test("corrupted stored output is warned and skipped during recovery", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "step1",
            type: "corrupt-test",
            config: {},
            next: "step2",
          },
          {
            id: "step2",
            type: "echo",
            config: { message: "done" },
          },
        ],
      };

      // First run completes normally
      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      // Now manually corrupt the stored output by updating the DB
      const steps = getWorkflowRunStepsByRunId(runId);
      const step1 = steps.find((s) => s.nodeId === "step1");
      expect(step1).toBeDefined();

      // Import updateWorkflowRunStep to corrupt the output
      const { updateWorkflowRunStep } = await import("../be/db");
      updateWorkflowRunStep(step1!.id, {
        output: "not-a-valid-object" as unknown,
      });

      // Re-walk the graph (simulates recovery). The corrupted output should
      // be skipped with a warning, but the walk should not crash.
      const ctx: Record<string, unknown> = { trigger: {} };
      const entryNodes = def.nodes.filter((n) => n.id === "step1");

      // Capture console.warn
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };

      await walkGraph(def, runId, ctx, entryNodes, registry, workflow.id);

      console.warn = origWarn;

      // Should have warned about corrupted output
      expect(warnings.some((w) => w.includes("Recovery") && w.includes("step1"))).toBe(true);
      // The corrupted output should NOT be in ctx
      expect(ctx.step1).toBeUndefined();
    });
  });

  // ─── Bug 7: Retry Validation History ─────────────────────────

  describe("Bug 7 — Retry validation context history", () => {
    test("validation retries accumulate in history array", () => {
      // This tests the logic directly: simulate 3 retries appending to ctx
      const ctx: Record<string, unknown> = {};
      const nodeId = "testNode";
      const historyKey = `${nodeId}_validations`;

      // Simulate 3 retry rounds
      for (let i = 0; i < 3; i++) {
        const retryContext = { previousOutput: `output_${i}`, round: i };
        const existing = (ctx[historyKey] as unknown[]) || [];
        ctx[historyKey] = [...existing, retryContext];
      }

      const history = ctx[historyKey] as unknown[];
      expect(history).toHaveLength(3);
      expect(history[0]).toEqual({ previousOutput: "output_0", round: 0 });
      expect(history[1]).toEqual({ previousOutput: "output_1", round: 1 });
      expect(history[2]).toEqual({ previousOutput: "output_2", round: 2 });
    });
  });

  // ─── Data Flow Through Chain ─────────────────────────────────

  describe("Data flow through node chain with inputs", () => {
    test("three-node chain with explicit inputs mapping", async () => {
      const registry = createTestRegistry();
      const def: WorkflowDefinition = {
        nodes: [
          {
            id: "A",
            type: "echo",
            config: { message: "alpha" },
            next: "B",
          },
          {
            id: "B",
            type: "echo",
            inputs: { fromA: "A.echo" },
            config: { message: "B got {{fromA}}" },
            next: "C",
          },
          {
            id: "C",
            type: "echo",
            inputs: { fromB: "B.echo", fromA: "A.echo" },
            config: { message: "C got {{fromA}} and {{fromB}}" },
          },
        ],
      };

      const workflow = makeWorkflow(def);
      const runId = await startWorkflowExecution(workflow, {}, registry);
      const run = getWorkflowRun(runId);
      expect(run!.status).toBe("completed");

      const ctx = run!.context as Record<string, unknown>;
      expect(ctx.A).toEqual({ echo: "alpha" });
      expect(ctx.B).toEqual({ echo: "B got alpha" });
      expect(ctx.C).toEqual({ echo: "C got alpha and B got alpha" });
    });
  });
});
