import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution, TriggerSchemaError } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";

const TEST_DB_PATH = "./test-workflow-trigger-schema.sqlite";

// ─── Test Executor ──────────────────────────────────────────

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

// ─── Mock Dependencies ───────────────────────────────────────

const mockDeps: ExecutorDependencies = {
  db: {} as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (t: string) => t,
};

function createTestRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new EchoExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;
const createdWorkflowIds: string[] = [];

function makeWorkflow(
  def: WorkflowDefinition,
  overrides?: { triggerSchema?: Record<string, unknown> },
): Workflow {
  workflowCounter++;
  const workflow = createWorkflow({
    name: `test-trigger-schema-${workflowCounter}-${Date.now()}`,
    definition: def,
    triggerSchema: overrides?.triggerSchema,
  });
  createdWorkflowIds.push(workflow.id);
  return workflow;
}

// ─── Tests ───────────────────────────────────────────────────

describe("Workflow triggerSchema (Phase 4)", () => {
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

  // ─── Valid Trigger Payload ──────────────────────────────────

  test("valid trigger payload against schema — execution starts", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "step1",
          type: "echo",
          config: { message: "{{trigger.message}}" },
        },
      ],
    };

    const workflow = makeWorkflow(def, {
      triggerSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    });

    const runId = await startWorkflowExecution(workflow, { message: "hello world" }, registry);
    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");
  });

  // ─── Invalid Trigger Payload ────────────────────────────────

  test("invalid trigger payload — execution rejected with descriptive error", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "step1",
          type: "echo",
          config: { message: "{{trigger.message}}" },
        },
      ],
    };

    const workflow = makeWorkflow(def, {
      triggerSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    });

    try {
      await startWorkflowExecution(workflow, { wrong: "field" }, registry);
      throw new Error("Should have thrown TriggerSchemaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerSchemaError);
      const tsErr = err as TriggerSchemaError;
      expect(tsErr.validationErrors.length).toBeGreaterThan(0);
      expect(tsErr.message).toContain("message");
    }
  });

  // ─── No triggerSchema — Any Payload Accepted ────────────────

  test("no triggerSchema defined — any payload accepted (backward compat)", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "step1",
          type: "echo",
          config: { message: "hi" },
        },
      ],
    };

    // No triggerSchema
    const workflow = makeWorkflow(def);

    const runId = await startWorkflowExecution(
      workflow,
      { anything: "goes", nested: { deep: true } },
      registry,
    );
    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");
  });

  // ─── Required Fields ────────────────────────────────────────

  test("schema with required fields — missing field triggers error", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "step1",
          type: "echo",
          config: { message: "hi" },
        },
      ],
    };

    const workflow = makeWorkflow(def, {
      triggerSchema: {
        type: "object",
        required: ["repo", "branch"],
      },
    });

    try {
      await startWorkflowExecution(workflow, { repo: "myrepo" }, registry);
      throw new Error("Should have thrown TriggerSchemaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerSchemaError);
      const tsErr = err as TriggerSchemaError;
      // Should mention the missing "branch" field
      expect(tsErr.validationErrors.some((e) => e.includes("branch"))).toBe(true);
      // Should NOT mention "repo" (it's present)
      expect(tsErr.validationErrors.some((e) => e.includes("repo"))).toBe(false);
    }
  });

  // ─── Field-Level Error Details ──────────────────────────────

  test("trigger validation error includes field-level details", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "step1",
          type: "echo",
          config: { message: "hi" },
        },
      ],
    };

    const workflow = makeWorkflow(def, {
      triggerSchema: {
        type: "object",
        properties: {
          count: { type: "number" },
          name: { type: "string" },
        },
        required: ["count", "name"],
      },
    });

    try {
      // Pass wrong types for both fields
      await startWorkflowExecution(workflow, { count: "not-a-number", name: 42 }, registry);
      throw new Error("Should have thrown TriggerSchemaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerSchemaError);
      const tsErr = err as TriggerSchemaError;
      // Should have field-level details for both fields
      expect(tsErr.validationErrors.some((e) => e.includes("count"))).toBe(true);
      expect(tsErr.validationErrors.some((e) => e.includes("name"))).toBe(true);
    }
  });

  // ─── TriggerSchemaError Properties ──────────────────────────

  test("TriggerSchemaError has correct name and validationErrors array", () => {
    const errors = ['root: missing required property "foo"', 'bar: expected type "number"'];
    const err = new TriggerSchemaError(errors);
    expect(err.name).toBe("TriggerSchemaError");
    expect(err.validationErrors).toEqual(errors);
    expect(err.message).toContain("foo");
    expect(err.message).toContain("bar");
    expect(err).toBeInstanceOf(Error);
  });

  // ─── triggerSchema Persisted in DB ──────────────────────────

  test("triggerSchema is persisted and retrieved from DB", () => {
    const def: WorkflowDefinition = {
      nodes: [{ id: "s1", type: "echo", config: { message: "hi" } }],
    };

    const schema = {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    };

    const workflow = makeWorkflow(def, { triggerSchema: schema });
    const loaded = getWorkflow(workflow.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.triggerSchema).toEqual(schema);
  });

  test("workflow without triggerSchema has undefined triggerSchema", () => {
    const def: WorkflowDefinition = {
      nodes: [{ id: "s1", type: "echo", config: { message: "hi" } }],
    };

    const workflow = makeWorkflow(def);
    const loaded = getWorkflow(workflow.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.triggerSchema).toBeUndefined();
  });

  // ─── Wrong Root Type ────────────────────────────────────────

  test("trigger data of wrong root type — rejected", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [{ id: "s1", type: "echo", config: { message: "hi" } }],
    };

    const workflow = makeWorkflow(def, {
      triggerSchema: { type: "object" },
    });

    try {
      // Pass a string instead of an object
      await startWorkflowExecution(workflow, "just a string", registry);
      throw new Error("Should have thrown TriggerSchemaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerSchemaError);
      const tsErr = err as TriggerSchemaError;
      expect(tsErr.validationErrors[0]).toContain("object");
    }
  });

  // ─── Null Trigger Data ──────────────────────────────────────

  test("null trigger data against object schema — rejected", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [{ id: "s1", type: "echo", config: { message: "hi" } }],
    };

    const workflow = makeWorkflow(def, {
      triggerSchema: { type: "object" },
    });

    try {
      await startWorkflowExecution(workflow, null, registry);
      throw new Error("Should have thrown TriggerSchemaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TriggerSchemaError);
    }
  });

  // ─── Empty Schema — Accepts Anything ────────────────────────

  test("empty triggerSchema ({}) — accepts any payload", async () => {
    const registry = createTestRegistry();
    const def: WorkflowDefinition = {
      nodes: [{ id: "s1", type: "echo", config: { message: "hi" } }],
    };

    const workflow = makeWorkflow(def, { triggerSchema: {} });

    const runId = await startWorkflowExecution(workflow, { anything: "goes" }, registry);
    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");
  });
});
