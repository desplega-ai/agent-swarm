import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createUser, getTaskById, initDb } from "../be/db";
import { createUserServer, userSendTaskInputSchema } from "../server-user";
import { registerSendTaskTool, sendTaskInputSchema } from "../tools/send-task";

const TEST_DB_PATH = "./test-send-task-output-schema.sqlite";

const LEAD_ID = "11111111-1111-4111-a111-111111111111";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  };
  return tool.handler(args, extra);
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    task?: { id: string; outputSchema?: Record<string, unknown> };
    message: string;
  };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Test Lead", isLead: true, status: "idle" });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("sendTaskInputSchema: outputSchema field validation", () => {
  test("accepts a well-formed JSON Schema object", () => {
    const result = sendTaskInputSchema.safeParse({
      task: "do the thing",
      outputSchema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { type: "string", enum: ["approved", "changes_requested"] } },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a non-object outputSchema", () => {
    const result = sendTaskInputSchema.safeParse({
      task: "do the thing",
      outputSchema: "not-a-schema",
    });
    expect(result.success).toBe(false);
  });

  test("is absent by default — omitting it still validates", () => {
    const result = sendTaskInputSchema.safeParse({ task: "do the thing" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputSchema).toBeUndefined();
    }
  });

  test("rejects a malformed nested outputSchema (properties value is null)", () => {
    const result = sendTaskInputSchema.safeParse({
      task: "x",
      outputSchema: { type: "object", properties: { answer: null } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(" | ");
      expect(messages).toContain("outputSchema.properties.answer");
    }
  });
});

describe("userSendTaskInputSchema (/mcp-user): outputSchema field validation", () => {
  test("accepts a well-formed JSON Schema object", () => {
    const result = userSendTaskInputSchema.safeParse({
      task: "do the thing",
      outputSchema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { type: "string" } },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a malformed nested outputSchema (properties value is null)", () => {
    const result = userSendTaskInputSchema.safeParse({
      task: "x",
      outputSchema: { type: "object", properties: { answer: null } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(" | ");
      expect(messages).toContain("outputSchema.properties.answer");
    }
  });
});

describe("send-task: outputSchema propagation", () => {
  const server = new McpServer({ name: "test-send-task-output-schema", version: "1.0.0" });
  registerSendTaskTool(server);

  test("existing callers that omit outputSchema keep working (backwards compatible)", async () => {
    const result = await callSendTask(
      server,
      { task: "unassigned task without a schema", allowDuplicate: true },
      LEAD_ID,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toBeUndefined();
  });

  test("a provided outputSchema is persisted on the created task", async () => {
    const schema = {
      type: "object",
      required: ["verdict", "headSha"],
      properties: {
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
        headSha: { type: "string", const: "abc123" },
      },
    };
    const result = await callSendTask(
      server,
      { task: "unassigned task with a schema", outputSchema: schema, allowDuplicate: true },
      LEAD_ID,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toEqual(schema);
  });

  test("a provided outputSchema is persisted when the task is offered to an agent", async () => {
    const worker = await createAgent({
      name: "Offer worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
    });
    const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const result = await callSendTask(
      server,
      {
        task: "offered task with a schema",
        agentId: worker.id,
        offerMode: true,
        outputSchema: schema,
        allowDuplicate: true,
      },
      LEAD_ID,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toEqual(schema);
  });

  test("a provided outputSchema is persisted on direct assignment", async () => {
    const worker = await createAgent({
      name: "Direct-assign worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
    });
    const schema = {
      type: "object",
      required: ["done"],
      properties: { done: { type: "boolean" } },
    };
    const result = await callSendTask(
      server,
      {
        task: "directly assigned task with a schema",
        agentId: worker.id,
        outputSchema: schema,
        allowDuplicate: true,
      },
      LEAD_ID,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toEqual(schema);
  });
});

describe("send-task: /mcp-user surface propagation", () => {
  type UserRegisteredTool = {
    handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
  };

  test("outputSchema is forwarded and persisted through the user MCP surface", async () => {
    const owner = await createUser({ name: "Output schema user" });
    const userServer = createUserServer(owner);
    const tools = (
      userServer as unknown as { _registeredTools: Record<string, UserRegisteredTool> }
    )._registeredTools;
    const tool = tools["send-task"];
    if (!tool) throw new Error("send-task not registered on the user surface");

    const schema = {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string" } },
    };
    const result = await tool.handler(
      { task: "user task with a schema", outputSchema: schema, allowDuplicate: true },
      { sessionId: "user-output-schema-test", requestInfo: { headers: {} } },
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toEqual(schema);
  });
});
