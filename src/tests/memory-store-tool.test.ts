import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createTask, getDbClient, initDb } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerMemoryStoreTool } from "../tools/memory-store";

const TEST_DB_PATH = "./test-memory-store-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StructuredResult = {
  isError?: boolean;
  structuredContent: {
    success: boolean;
    message: string;
    memoryIds?: string[];
    chunks?: number;
    queued?: boolean;
  };
};

const agentA = "aaaa0000-0000-4000-8000-000000000201";

function buildTool(): RegisteredTool {
  const server = new McpServer({ name: "memory-store-test", version: "1.0.0" });
  registerMemoryStoreTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["memory-store"];
  if (!tool) throw new Error("memory-store tool not registered");
  return tool;
}

function meta(agentId: string | undefined) {
  const headers: Record<string, string> = {};
  if (agentId) headers["x-agent-id"] = agentId;
  return { sessionId: "memory-store-test-session", requestInfo: { headers } };
}

describe("memory-store MCP tool", () => {
  const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    // Keep the embedding provider keyless so it returns null instead of
    // calling the network.
    process.env.EMBEDDING_API_KEY = "";
    process.env.OPENAI_API_KEY = "";

    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }

    initDb(TEST_DB_PATH);
    await createAgent({ id: agentA, name: "Memory Store Agent A", isLead: false, status: "idle" });
  });

  afterAll(async () => {
    if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;

    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  beforeEach(async () => {
    await getDbClient().run("DELETE FROM memory_link");
    await getDbClient().run("DELETE FROM agent_memory");
  });

  test("rejects a call without an agent ID", async () => {
    const result = (await buildTool().handler(
      { content: "some learning", name: "no identity", scope: "agent" },
      meta(undefined),
    )) as StructuredResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("Agent ID required");
  });

  test("stores an agent-scoped memory owned by the caller", async () => {
    const result = (await buildTool().handler(
      {
        content: "Bun auto-loads .env, so dotenv is never needed in this repo.",
        name: "bun env loading",
        scope: "agent",
        tags: ["bun", "agent-swarm"],
        intent: "remember a repo convention",
      },
      meta(agentA),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.queued).toBe(true);
    expect(result.structuredContent.chunks).toBe(1);
    expect(result.structuredContent.memoryIds).toHaveLength(1);

    const memory = await getMemoryStore().peek(result.structuredContent.memoryIds![0]!);
    expect(memory?.agentId).toBe(agentA);
    expect(memory?.scope).toBe("agent");
    expect(memory?.source).toBe("manual");
    expect(memory?.name).toBe("bun env loading");
    expect(memory?.tags).toEqual(["bun", "agent-swarm"]);
    expect(memory?.sourceTaskId).toBeNull();
  });

  test("stores a swarm-scoped memory still owned by the caller", async () => {
    const result = (await buildTool().handler(
      {
        content: "The API server is the sole owner of the SQLite database.",
        name: "db ownership invariant",
        scope: "swarm",
      },
      meta(agentA),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(true);

    const memory = await getMemoryStore().peek(result.structuredContent.memoryIds![0]!);
    expect(memory?.agentId).toBe(agentA);
    expect(memory?.scope).toBe("swarm");
  });

  test("records the source task when taskId is given", async () => {
    const task = await createTask(agentA, "investigate the flaky heartbeat sweep");

    const result = (await buildTool().handler(
      {
        content: "The heartbeat sweep needs a fractional threshold to be testable.",
        name: "heartbeat threshold",
        scope: "agent",
        taskId: task.id,
      },
      meta(agentA),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(true);

    const memory = await getMemoryStore().peek(result.structuredContent.memoryIds![0]!);
    expect(memory?.sourceTaskId).toBe(task.id);
  });

  test("splits long markdown content into several chunks", async () => {
    const section = (title: string, filler: string) => `## ${title}\n\n${filler.repeat(150)}\n\n`;
    const content =
      section("First finding", "alpha alpha ") +
      section("Second finding", "beta beta ") +
      section("Third finding", "gamma gamma ");

    const result = (await buildTool().handler(
      { content, name: "long research note", scope: "agent" },
      meta(agentA),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(true);
    const chunks = result.structuredContent.chunks!;
    expect(chunks).toBeGreaterThan(1);
    expect(result.structuredContent.memoryIds).toHaveLength(chunks);

    for (const id of result.structuredContent.memoryIds!) {
      expect((await getMemoryStore().peek(id))?.totalChunks).toBe(chunks);
    }
  });
});
