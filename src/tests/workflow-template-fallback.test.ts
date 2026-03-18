import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createWorkflow, getAllTasks, initDb } from "../be/db";
import { startWorkflowExecution } from "../workflows/engine";
import { executeSendMessage } from "../workflows/nodes/send-message";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-template-fallback.sqlite";

describe("interpolate() guard", () => {
  test("returns empty string when template is undefined", () => {
    expect(interpolate(undefined as unknown as string, {})).toBe("");
  });

  test("returns empty string when template is null", () => {
    expect(interpolate(null as unknown as string, {})).toBe("");
  });

  test("returns empty string when template is a number", () => {
    expect(interpolate(42 as unknown as string, {})).toBe("");
  });

  test("interpolates valid template normally", () => {
    expect(interpolate("hello {{name}}", { name: "world" })).toBe("hello world");
  });

  test("handles nested path interpolation", () => {
    expect(interpolate("{{user.name}}", { user: { name: "Alice" } })).toBe("Alice");
  });

  test("returns empty for missing context keys", () => {
    expect(interpolate("{{missing}}", {})).toBe("");
  });

  test("logs a warning when template is not a string", () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      interpolate(undefined as unknown as string, {});
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("executeSendMessage fallbacks", () => {
  test("uses message field when template is missing", () => {
    const result = executeSendMessage({ message: "hello {{name}}" }, { name: "world" });
    expect(result.output).toEqual({ message: "hello world" });
  });

  test("prefers template over message when both provided", () => {
    const result = executeSendMessage({ template: "from template", message: "from message" }, {});
    expect(result.output).toEqual({ message: "from template" });
  });

  test("returns empty when both template and message are missing", () => {
    const result = executeSendMessage({}, {});
    expect(result.output).toEqual({ message: "" });
  });
});

describe("create-task and delegate-to-agent message fallback via workflow", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }
  });

  test("create-task node uses message field when template is missing", async () => {
    const wf = createWorkflow({
      name: "test-ct-message-fallback",
      definition: {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          { id: "ct1", type: "create-task", config: { message: "task for {{trigger.user}}" } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "ct1" }],
      },
    });
    const runId = await startWorkflowExecution(wf, { user: "Alice" });
    const created = getAllTasks().find((t) => t.workflowRunId === runId);
    expect(created).toBeDefined();
    expect(created!.task).toBe("task for Alice");
  });

  test("delegate-to-agent node uses message field when taskTemplate is missing", async () => {
    const agentId = crypto.randomUUID();
    const wf = createWorkflow({
      name: "test-da-message-fallback",
      definition: {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          {
            id: "da1",
            type: "delegate-to-agent",
            config: { agentId, message: "delegate {{trigger.action}}" },
          },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "da1" }],
      },
    });
    const runId = await startWorkflowExecution(wf, { action: "deploy" });
    const created = getAllTasks().find((t) => t.workflowRunId === runId);
    expect(created).toBeDefined();
    expect(created!.task).toBe("delegate deploy");
  });
});
