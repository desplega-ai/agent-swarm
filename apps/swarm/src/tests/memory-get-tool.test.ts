import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerMemoryGetTool } from "../tools/memory-get";
import type { AgentMemory } from "../types";

const TEST_DB_PATH = "./test-memory-get-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StructuredResult = {
  structuredContent: {
    success: boolean;
    message: string;
    memory?: AgentMemory;
  };
};

const agentA = "aaaa0000-0000-4000-8000-000000000101";
const agentB = "bbbb0000-0000-4000-8000-000000000102";

function buildTool(): RegisteredTool {
  const server = new McpServer({ name: "memory-get-test", version: "1.0.0" });
  registerMemoryGetTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["memory-get"];
  if (!tool) throw new Error("memory-get tool not registered");
  return tool;
}

function meta(agentId: string | undefined) {
  const headers: Record<string, string> = {};
  if (agentId) headers["x-agent-id"] = agentId;
  return { sessionId: "memory-get-test-session", requestInfo: { headers } };
}

describe("memory-get MCP authorization", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }

    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "Memory Get Agent A", isLead: false, status: "idle" });
    createAgent({ id: agentB, name: "Memory Get Agent B", isLead: true, status: "idle" });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  beforeEach(() => {
    getDb().run("DELETE FROM memory_retrieval");
    getDb().run("DELETE FROM agent_memory");
  });

  test("allows an agent to read its own agent-scoped memory", async () => {
    const memory = getMemoryStore().store({
      agentId: agentA,
      scope: "agent",
      name: "private-a",
      content: "agent A private content",
      source: "manual",
    });

    const result = (await buildTool().handler(
      { memoryId: memory.id, intent: "test own memory read" },
      meta(agentA),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.memory?.id).toBe(memory.id);
    expect(result.structuredContent.memory?.content).toBe("agent A private content");
  });

  test("blocks another agent from reading agent-scoped memory", async () => {
    const memory = getMemoryStore().store({
      agentId: agentA,
      scope: "agent",
      name: "private-a",
      content: "agent A private content",
      source: "manual",
    });

    const result = (await buildTool().handler(
      { memoryId: memory.id, intent: "test cross-agent memory read" },
      meta(agentB),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Not authorized");
    expect(result.structuredContent.memory).toBeUndefined();

    const row = getDb()
      .prepare<{ accessCount: number }, [string]>(
        "SELECT accessCount FROM agent_memory WHERE id = ?",
      )
      .get(memory.id);
    expect(row?.accessCount).toBe(0);
  });

  test("allows cross-agent reads of swarm-scoped memory", async () => {
    const memory = getMemoryStore().store({
      agentId: agentA,
      scope: "swarm",
      name: "shared-memory",
      content: "shared content",
      source: "manual",
    });

    const result = (await buildTool().handler(
      { memoryId: memory.id, intent: "test swarm memory read" },
      meta(agentB),
    )) as StructuredResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.memory?.id).toBe(memory.id);
    expect(result.structuredContent.memory?.content).toBe("shared content");
  });
});
