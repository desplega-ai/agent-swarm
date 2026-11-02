import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { registerSendTaskTool } from "../tools/send-task";

const TEST_DB_PATH = "./test-send-task-dispatched-by.sqlite";

const LEAD_ID = "31111111-1111-4111-a111-111111111111";
const WORKER_ID = "32222222-2222-4222-a222-222222222222";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

const server = new McpServer({ name: "test-send-task-dispatched-by", version: "1.0.0" });
registerSendTaskTool(server);

async function sendTask(args: Record<string, unknown>, sourceTaskId?: string) {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const headers: Record<string, string> = { "x-agent-id": LEAD_ID };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  const result = await tools["send-task"]!.handler(
    { allowDuplicate: true, ...args },
    { sessionId: "test-session", requestInfo: { headers } },
  );
  const s = result.structuredContent as {
    success: boolean;
    message: string;
    task?: { id: string };
  };
  expect(s.message).toBeString();
  expect(s.success).toBe(true);
  const created = await getTaskById(s.task!.id);
  if (!created) throw new Error("send-task created no task");
  return created;
}

async function leadTurn(text: string) {
  return createTaskExtended(text, { agentId: LEAD_ID, source: "slack" });
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
  await createAgent({
    id: WORKER_ID,
    name: "Test Researcher",
    isLead: false,
    status: "idle",
    maxTasks: 5,
  });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("send-task: dispatchedByTaskId", () => {
  test("a continuation keeps parentTaskId on the earlier worker task and records the dispatching turn", async () => {
    const firstTurn = await leadTurn("first turn");
    const earlier = await sendTask(
      {
        task: "research the pricing page",
        agentId: WORKER_ID,
        routingReason: "skill",
        routingNote: "researcher owns this area",
      },
      firstTurn.id,
    );
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [
      earlier.id,
    ]);

    const laterTurn = await leadTurn("later turn");
    const continuation = await sendTask(
      { task: "extend the pricing research", parentTaskId: earlier.id },
      laterTurn.id,
    );

    expect(continuation.parentTaskId).toBe(earlier.id);
    expect(continuation.agentId).toBe(WORKER_ID);
    expect(continuation.dispatchedByTaskId).toBe(laterTurn.id);
    expect(earlier.dispatchedByTaskId).toBe(firstTurn.id);
  });

  test("without parentTaskId both columns name the caller's task", async () => {
    const turn = await leadTurn("plain delegation");
    const child = await sendTask({ task: "pool work" }, turn.id);
    expect(child.parentTaskId).toBe(turn.id);
    expect(child.dispatchedByTaskId).toBe(turn.id);
  });

  test("a caller outside a task records no dispatcher", async () => {
    const child = await sendTask({ task: "pool work, no source task" });
    expect(child.parentTaskId).toBeUndefined();
    expect(child.dispatchedByTaskId).toBeUndefined();
  });

  test("tasks created outside send-task leave the column null", async () => {
    const turn = await leadTurn("a turn");
    const child = await createTaskExtended("system child", {
      parentTaskId: turn.id,
      sourceTaskId: turn.id,
      source: "system",
    });
    expect(child.dispatchedByTaskId).toBeUndefined();
  });
});
