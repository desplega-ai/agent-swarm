import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getTaskById,
  initDb,
} from "../be/db";
import { registerSendTaskTool } from "../tools/send-task";

const TEST_DB_PATH = "./test-send-task-requested-by.sqlite";

const LEAD_ID = "11111111-1111-4111-a111-111111111111";
const WORKER_ID = "22222222-2222-4222-a222-222222222222";

let userAId: string;
let userBId: string;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const headers: Record<string, string> = { "x-agent-id": callerAgentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers },
  };
  return tool.handler(args, extra);
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    task?: { id: string; requestedByUserId?: string };
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
  createAgent({ id: LEAD_ID, name: "Test Lead", isLead: true, status: "idle" });
  createAgent({ id: WORKER_ID, name: "Test Worker", isLead: false, status: "idle" });
  userAId = createUser({ name: "User A", email: "user-a@example.com" }).id;
  userBId = createUser({ name: "User B", email: "user-b@example.com" }).id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("send-task: requestedByUserId inheritance", () => {
  const server = new McpServer({ name: "test-send-task", version: "1.0.0" });
  registerSendTaskTool(server);

  test("child pool task inherits requestedByUserId from caller's sourceTaskId", async () => {
    // Parent task has no agentId so the auto-route won't force a lead assignment.
    const parentTask = createTaskExtended("parent pool task", {
      requestedByUserId: userAId,
    });

    const result = await callSendTask(
      server,
      { task: "child pool task — inherit", allowDuplicate: true },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    expect(s.task).toBeDefined();
    const created = getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBe(userAId);
  });

  test("explicit requestedByUserId in args wins over inherited value", async () => {
    const parentTask = createTaskExtended("parent with user A", {
      requestedByUserId: userAId,
    });

    const result = await callSendTask(
      server,
      { task: "child with override user B", requestedByUserId: userBId, allowDuplicate: true },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBe(userBId);
  });

  test("no crash when caller has no sourceTaskId and no requestedByUserId arg", async () => {
    const result = await callSendTask(
      server,
      { task: "anonymous task — no requester", allowDuplicate: true },
      LEAD_ID,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBeFalsy();
  });

  test("direct assignment to worker inherits requestedByUserId from caller's sourceTaskId", async () => {
    // Parent assigned to WORKER so auto-route would pick WORKER, but we pass agentId explicitly.
    const parentTask = createTaskExtended("parent for direct assign", {
      requestedByUserId: userAId,
    });

    const result = await callSendTask(
      server,
      {
        task: "worker direct assign — inherit user",
        agentId: WORKER_ID,
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    expect(created?.requestedByUserId).toBe(userAId);
  });
});
