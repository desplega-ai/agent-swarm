import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getTaskById,
  initDb,
} from "../be/db";
import { validateJsonSchema } from "../workflows/json-schema-validator";

const TEST_DB_PATH = "./test-structured-output.sqlite";

// ─── Setup / Teardown ────────────────────────────────────────

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

// ─── JSON Schema Validator Tests ─────────────────────────────

describe("validateJsonSchema — enum and const extensions", () => {
  test("enum: valid value passes", () => {
    const schema = { type: "string", enum: ["red", "green", "blue"] };
    const errors = validateJsonSchema(schema, "red");
    expect(errors).toEqual([]);
  });

  test("enum: invalid value fails", () => {
    const schema = { type: "string", enum: ["red", "green", "blue"] };
    const errors = validateJsonSchema(schema, "yellow");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("not in enum");
  });

  test("enum: numeric enum works", () => {
    const schema = { type: "number", enum: [1, 2, 3] };
    expect(validateJsonSchema(schema, 2)).toEqual([]);
    expect(validateJsonSchema(schema, 5).length).toBe(1);
  });

  test("const: matching value passes", () => {
    const schema = { const: "fixed-value" };
    expect(validateJsonSchema(schema, "fixed-value")).toEqual([]);
  });

  test("const: mismatched value fails", () => {
    const schema = { const: 42 };
    const errors = validateJsonSchema(schema, 43);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("does not match const");
  });

  test("items: validates array items", () => {
    const schema = {
      type: "array",
      items: { type: "number" },
    };
    expect(validateJsonSchema(schema, [1, 2, 3])).toEqual([]);
    const errors = validateJsonSchema(schema, [1, "two", 3]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("root[1]");
  });

  test("nested object with enum property", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "inactive"] },
        count: { type: "number" },
      },
      required: ["status"],
    };
    expect(validateJsonSchema(schema, { status: "active", count: 5 })).toEqual([]);
    expect(validateJsonSchema(schema, { status: "unknown" }).length).toBe(1);
  });
});

// ─── DB: outputSchema storage ────────────────────────────────

describe("Task outputSchema storage", () => {
  test("createTaskExtended stores outputSchema", () => {
    const schema = {
      type: "object",
      properties: { fileCount: { type: "number" } },
      required: ["fileCount"],
    };
    const task = createTaskExtended("Count files", {
      source: "api",
      outputSchema: schema,
    });

    const fetched = getTaskById(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.outputSchema).toBeDefined();
    expect(fetched!.outputSchema).toEqual(schema);
  });

  test("createTaskExtended without outputSchema returns undefined", () => {
    const task = createTaskExtended("Simple task", { source: "api" });
    const fetched = getTaskById(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.outputSchema).toBeUndefined();
  });
});

// ─── Store-progress validation logic (unit-level) ────────────

describe("Structured output validation logic", () => {
  test("valid JSON matching schema passes validation", () => {
    const schema = {
      type: "object",
      properties: {
        fileCount: { type: "number" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["fileCount"],
    };
    const output = JSON.stringify({ fileCount: 42, files: ["a.txt", "b.txt"] });
    const parsed = JSON.parse(output);
    const errors = validateJsonSchema(schema, parsed);
    expect(errors).toEqual([]);
  });

  test("valid JSON not matching schema produces errors", () => {
    const schema = {
      type: "object",
      properties: {
        fileCount: { type: "number" },
      },
      required: ["fileCount"],
    };
    const parsed = { name: "test" }; // Missing fileCount
    const errors = validateJsonSchema(schema, parsed);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("fileCount");
  });

  test("wrong type produces error", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
    };
    const parsed = { count: "not-a-number" };
    const errors = validateJsonSchema(schema, parsed);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("expected type");
  });
});

// ─── Resume: JSON-parse structured output ────────────────────

describe("Resume — structured output JSON parsing", () => {
  test("JSON string output gets parsed to object", () => {
    const output = JSON.stringify({ fileCount: 42, path: "/tmp" });
    let taskOutput: unknown = output;
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed === "object" && parsed !== null) {
        taskOutput = parsed;
      }
    } catch {
      // keep as string
    }
    expect(typeof taskOutput).toBe("object");
    expect((taskOutput as { fileCount: number }).fileCount).toBe(42);
  });

  test("plain text output stays as string", () => {
    const output = "Just a plain text result";
    let taskOutput: unknown = output;
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed === "object" && parsed !== null) {
        taskOutput = parsed;
      }
    } catch {
      // keep as string
    }
    expect(typeof taskOutput).toBe("string");
    expect(taskOutput).toBe("Just a plain text result");
  });

  test("JSON number stays as string (not object)", () => {
    const output = "42";
    let taskOutput: unknown = output;
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed === "object" && parsed !== null) {
        taskOutput = parsed;
      }
    } catch {
      // keep as string
    }
    // 42 parses but is not an object, so stays as string
    expect(typeof taskOutput).toBe("string");
  });

  test("JSON array gets parsed", () => {
    const output = JSON.stringify([1, 2, 3]);
    let taskOutput: unknown = output;
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed === "object" && parsed !== null) {
        taskOutput = parsed;
      }
    } catch {
      // keep as string
    }
    expect(Array.isArray(taskOutput)).toBe(true);
  });
});

// ─── AgentTask executor config schema ────────────────────────

describe("AgentTaskConfigSchema — outputSchema", () => {
  test("accepts outputSchema in config", async () => {
    const { AgentTaskExecutor } = await import("../workflows/executors/agent-task");
    const executor = new AgentTaskExecutor({
      // biome-ignore lint/suspicious/noExplicitAny: mock DB for test
      db: {} as any,
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (t: string) => t,
    });

    const config = {
      template: "Count files",
      outputSchema: {
        type: "object",
        properties: { fileCount: { type: "number" } },
        required: ["fileCount"],
      },
    };
    const parsed = executor.configSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outputSchema).toEqual(config.outputSchema);
    }
  });
});

// ─── Workflow agent-task → DB with outputSchema ──────────────

describe("Workflow agent-task creates task with outputSchema", () => {
  test("outputSchema flows from executor config to created task", async () => {
    const { AgentTaskExecutor } = await import("../workflows/executors/agent-task");
    const db = await import("../be/db");

    const executor = new AgentTaskExecutor({
      db: db as typeof import("../be/db"),
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (t: string) => t,
    });

    // Create prerequisites for FK constraints
    const wf = createWorkflow({ name: "test-output-schema", definition: { nodes: [], edges: [] } });
    const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    const step = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "n1",
      nodeType: "agent-task",
    });

    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };

    const result = await executor.run({
      config: {
        template: "Summarize the document",
        outputSchema: schema,
      },
      context: {},
      meta: {
        runId: run.id,
        stepId: step.id,
        nodeId: "n1",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("success");
    const taskId = (result as { correlationId?: string }).correlationId!;
    const task = getTaskById(taskId);
    expect(task).toBeDefined();
    expect(task!.outputSchema).toEqual(schema);
  });
});
