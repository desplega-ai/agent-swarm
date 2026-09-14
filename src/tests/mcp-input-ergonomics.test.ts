import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import {
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  createUser,
  getAgentById,
  getDbClient,
  getSteeringMessageById,
  getTaskById,
  initDb,
  markSteeringDelivered,
  startTask,
} from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerAcceptSteerTool } from "../tools/accept-steer";
import { getTaskDetailsInputSchema } from "../tools/get-task-details";
import { registerMemoryGetTool } from "../tools/memory-get";
import { registerMemoryRateTool } from "../tools/memory-rate";
import { registerMemorySearchTool } from "../tools/memory-search";
import { registerMemoryStoreTool } from "../tools/memory-store";
import { registerSendTaskTool, sendTaskInputSchema } from "../tools/send-task";
import { registerStoreProgressTool } from "../tools/store-progress";
import type { SwarmToolResult } from "../tools/utils";

const agentId = "aaaa0000-0000-4000-8000-000000000901";
const otherId = "bbbb0000-0000-4000-8000-000000000902";
const server = new McpServer({ name: "input-regressions", version: "1.0.0" });
for (const register of [
  registerAcceptSteerTool,
  registerMemoryGetTool,
  registerMemoryRateTool,
  registerMemorySearchTool,
  registerMemoryStoreTool,
  registerSendTaskTool,
  registerStoreProgressTool,
]) {
  register(server);
}
const registered = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        inputSchema: ZodType;
        handler: (args: unknown, meta: unknown) => Promise<SwarmToolResult>;
      }
    >;
  }
)._registeredTools;

async function call(name: string, args: unknown, sourceTaskId?: string, callerId = agentId) {
  const tool = registered[name]!;
  // Exercise the real registered schema before invoking the handler, as MCP does.
  return tool.handler(tool.inputSchema.parse(args), {
    sessionId: "input-regressions-session",
    requestInfo: {
      headers: {
        "x-agent-id": callerId,
        ...(sourceTaskId ? { "x-source-task-id": sourceTaskId } : {}),
      },
    },
  });
}
async function task(owner = agentId) {
  const row = await createTaskExtended("input schema regression", {
    agentId: owner,
    source: "system",
    followUpConfig: { disabled: true },
  });
  await startTask(row.id);
  return row;
}
const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
beforeAll(async () => {
  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  initDb(":memory:");
  await createAgent({ id: agentId, name: "Schema worker", isLead: false, status: "idle" });
  await createAgent({ id: otherId, name: "Other schema worker", isLead: false, status: "idle" });
});
afterAll(() => {
  closeDb();
  if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("store-progress input recovery", () => {
  for (const status of ["pending", "in_progress"]) {
    test(`${status} stores progress without finishing or requeueing`, async () => {
      const row = await task();
      const result = await call("store-progress", {
        taskId: row.id,
        status,
        progress: status,
        output: "must not complete",
        failureReason: "must not fail",
      });
      expect(result.structuredContent?.success).toBe(true);
      const updated = await getTaskById(row.id);
      expect(updated?.progress).toBe(status);
      expect(updated?.status).toBe("in_progress");
      expect(updated?.finishedAt).toBeUndefined();
      expect(updated?.output).toBeUndefined();
      expect((await getAgentById(agentId))?.status).toBe("busy");
      expect(result.structuredContent?.message).not.toContain("marked as");
    });
  }
  test("omitted taskId uses only the caller-owned source task", async () => {
    const row = await task();
    expect(
      (await call("store-progress", { progress: "context works" }, row.id)).structuredContent
        ?.success,
    ).toBe(true);
    expect((await getTaskById(row.id))?.progress).toBe("context works");
  });
  test("omitted taskId with no context returns actionable failure", async () => {
    const result = await call("store-progress", { progress: "lost" });
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain("full task UUID");
  });
  test("omitted taskId cannot borrow another agent's source task", async () => {
    const row = await task(otherId);
    expect(
      (await call("store-progress", { status: "completed" }, row.id)).structuredContent?.success,
    ).toBe(false);
    expect((await getTaskById(row.id))?.status).toBe("in_progress");
  });
  test("explicit target wins over source task", async () => {
    const source = await task();
    const target = await task();
    await call("store-progress", { taskId: target.id, progress: "explicit" }, source.id);
    expect((await getTaskById(source.id))?.progress).toBeUndefined();
    expect((await getTaskById(target.id))?.progress).toBe("explicit");
  });
  test("terminal calls still finish, and progress aliases cannot revive them", async () => {
    for (const status of ["completed", "failed"]) {
      const row = await task();
      const result = await call("store-progress", {
        taskId: row.id,
        status,
        output: "done",
        failureReason: "failed",
      });
      expect(result.structuredContent?.success).toBe(true);
      const finished = await getTaskById(row.id);
      expect(finished?.status).toBe(status);
      await call("store-progress", { taskId: row.id, status: "pending", progress: "revive" });
      expect((await getTaskById(row.id))?.status).toBe(status);
      expect((await getTaskById(row.id))?.finishedAt).toBe(finished?.finishedAt);
    }
  });
  test("malformed explicit IDs and unsupported statuses stay invalid", () => {
    const schema = registered["store-progress"]!.inputSchema;
    expect(schema.safeParse({ taskId: "deadbeef" }).success).toBe(false);
    expect(schema.safeParse({ status: "cancelled" }).success).toBe(false);
  });
});

describe("memory input recovery", () => {
  test("search without intent returns a memory and records honest null intent", async () => {
    const row = await task();
    const memory = await getMemoryStore().store({
      agentId,
      scope: "agent",
      name: "needlequartz",
      content: "needlequartz",
      source: "manual",
    });
    const result = await call("memory-search", { query: "needlequartz" }, row.id);
    expect(result.structuredContent?.success).toBe(true);
    const retrieval = await getDbClient().get<{ intent: string | null }>(
      "SELECT intent FROM memory_retrieval WHERE memoryId = ? AND taskId = ?",
      [memory.id, row.id],
    );
    expect(retrieval).toBeDefined();
    expect(retrieval?.intent).toBeNull();
  });
  for (const field of ["id", "memoryId"]) {
    test(`get accepts ${field} without intent and preserves access control`, async () => {
      const row = await task();
      const memory = await getMemoryStore().store({
        agentId,
        scope: "agent",
        name: "private",
        content: "private fact",
        source: "manual",
      });
      expect(
        (await call("memory-get", { [field]: memory.id }, row.id)).structuredContent?.success,
      ).toBe(true);
      expect(
        (await call("memory-get", { [field]: memory.id }, undefined, otherId)).structuredContent
          ?.success,
      ).toBe(false);
      expect(
        (
          await getDbClient().get<{ intent: string | null }>(
            "SELECT intent FROM memory_retrieval WHERE memoryId = ? AND taskId = ?",
            [memory.id, row.id],
          )
        )?.intent,
      ).toBeNull();
    });
  }
  for (const name of ["memory-get", "memory_rate"]) {
    test(`${name} rejects missing and conflicting identifiers`, async () => {
      expect((await call(name, { useful: true })).structuredContent?.success).toBe(false);
      expect(
        (await call(name, { id: agentId, memoryId: otherId, useful: true })).structuredContent
          ?.success,
      ).toBe(false);
    });
  }
  test("rating aliases and long notes reach the endpoint within its 500-character limit", async () => {
    const originalFetch = globalThis.fetch;
    const events: Array<{ memoryId: string; reasoning: string }> = [];
    globalThis.fetch = (async (_input, init) => {
      events.push(JSON.parse(String(init?.body)).events[0]);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      for (const field of ["id", "memoryId"]) {
        expect(
          (
            await call(
              "memory_rate",
              { [field]: agentId, useful: true, note: "n".repeat(700) },
              otherId,
            )
          ).structuredContent?.success,
        ).toBe(true);
      }
      const aliasResult = await call("memory_rate", { memoryId: agentId, useful: true }, otherId);
      expect(aliasResult.structuredContent?.message).toBe(`Memory ${agentId} rated as useful.`);
      expect(
        events.slice(0, 2).map(({ memoryId, reasoning }) => ({ memoryId, reasoning })),
      ).toEqual([
        { memoryId: agentId, reasoning: "n".repeat(500) },
        { memoryId: agentId, reasoning: "n".repeat(500) },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("store derives missing title and normalizes comma-separated tags", async () => {
    const result = await call("memory-store", {
      content: "\n  Useful title  \nBody",
      tags: "bun, typescript, ,schema",
    });
    expect(result.structuredContent?.success).toBe(true);
    const ids = result.structuredContent?.memoryIds as string[];
    const memory = await getMemoryStore().peek(ids[0]!);
    expect(memory?.name).toBe("Useful title");
    expect(memory?.tags).toEqual(["bun", "typescript", "schema"]);
  });
  test("store keeps explicit title and array tags, bounds derived titles", async () => {
    for (const name of [undefined, "Explicit title"]) {
      const result = await call("memory-store", {
        content: "a".repeat(300),
        name,
        tags: ["one,two"],
      });
      const memory = await getMemoryStore().peek(
        (result.structuredContent?.memoryIds as string[])[0]!,
      );
      expect(memory?.name).toBe(name ?? "a".repeat(200));
      expect(memory?.tags).toEqual(["one,two"]);
    }
  });
  test("invalid field types and empty content/query remain invalid", () => {
    expect(registered["memory-store"]!.inputSchema.safeParse({ content: "" }).success).toBe(false);
    expect(
      registered["memory-store"]!.inputSchema.safeParse({ content: "body", tags: [2] }).success,
    ).toBe(false);
    expect(registered["memory-search"]!.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(registered["memory-get"]!.inputSchema.safeParse({ id: "deadbeef" }).success).toBe(false);
  });
});

test("accept-steer stores long notes and still requires task ownership", async () => {
  const row = await task();
  const steering = await createSteeringMessage({
    taskId: row.id,
    body: "adjust scope",
    mode: "queue",
    source: "api",
    createdByKind: "system",
  });
  await markSteeringDelivered(steering.id, "queue");
  const note = "Accepted scope. ".repeat(100);
  expect(
    (await call("accept-steer", { steeringMessageId: steering.id, note }, undefined, otherId))
      .structuredContent?.success,
  ).toBe(false);
  expect(
    (await call("accept-steer", { steeringMessageId: steering.id, note })).structuredContent
      ?.success,
  ).toBe(true);
  expect((await getSteeringMessageById(steering.id))?.handledNote).toBe(note);
});

test("send-task accepts actual registry user IDs without UUID hyphens", async () => {
  const user = await createUser({
    name: "Schema requester",
    email: "schema-requester@example.test",
  });
  expect(user.id).toMatch(/^[a-f0-9]{32}$/);
  const result = await call("send-task", {
    task: "requester preservation",
    requestedByUserId: user.id,
    allowDuplicate: true,
  });
  expect(result.structuredContent?.success).toBe(true);
  const created = result.structuredContent?.task as { id: string };
  expect((await getTaskById(created.id))?.requestedByUserId).toBe(user.id);
});

test("send-task rejects unknown requester IDs without creating a task", async () => {
  const before = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM agent_tasks",
  );
  const result = await call("send-task", {
    task: "unknown requester",
    requestedByUserId: "f".repeat(32),
    allowDuplicate: true,
  });
  expect(result.structuredContent?.success).toBe(false);
  expect(result.structuredContent?.message).toContain("existing registered user");
  expect(
    await getDbClient().get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_tasks"),
  ).toEqual(before);
});

test("send-task preserves inherited attribution when explicit requester is omitted", async () => {
  const { id: requesterId } = await createUser({
    name: "Inherited requester",
    email: "inherited-requester@example.test",
  });
  const parent = await createTaskExtended("historical requester", {
    agentId,
    requestedByUserId: requesterId,
  });
  await startTask(parent.id);
  const result = await call(
    "send-task",
    { task: "inherit requester", allowDuplicate: true, offerMode: true },
    parent.id,
  );
  expect(result.structuredContent?.success).toBe(true);
  const created = result.structuredContent?.task as { id: string };
  expect((await getTaskById(created.id))?.requestedByUserId).toBe(requesterId);
});

test("send-task requester format rejects arbitrary strings and hyphenated UUIDs", () => {
  for (const requestedByUserId of [
    "requester",
    agentId,
    "A".repeat(32),
    "x".repeat(32),
    "",
    "f".repeat(31),
  ]) {
    expect(
      sendTaskInputSchema.safeParse({ task: "invalid requester", requestedByUserId }).success,
    ).toBe(false);
  }
});

test("task UUIDs, parent references, and asset namespaces remain strict", () => {
  expect(
    getTaskDetailsInputSchema.safeParse({ taskId: "00dd3d42-0000-0000-0000-000000000000" }).success,
  ).toBe(false);
  expect(
    sendTaskInputSchema.safeParse({ task: "invalid parent", parentTaskId: "deadbeef" }).success,
  ).toBe(false);
  expect(
    sendTaskInputSchema.safeParse({ task: "invalid namespace", key: "probe:never" }).success,
  ).toBe(false);
});
