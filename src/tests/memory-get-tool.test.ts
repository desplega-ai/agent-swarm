import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { storeLinks } from "../be/memory/link-resolver";
import type { MemoryBacklinkView, MemoryLinkView } from "../be/memory/links-store";
import { handleMemory } from "../http/memory";
import { getPathSegments } from "../http/utils";
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
    links?: MemoryLinkView[];
    backlinks?: MemoryBacklinkView[];
  };
};

const agentA = "aaaa0000-0000-4000-8000-000000000101";
const agentB = "bbbb0000-0000-4000-8000-000000000102";
const agentC = "cccc0000-0000-4000-8000-000000000103";

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
    createAgent({ id: agentC, name: "Memory Get Agent C", isLead: false, status: "idle" });
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
    getDb().run("DELETE FROM memory_link");
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

  // ─── Link traversal blocks (DES-639b) ──────────────────────────────────────

  function seedLinkedPair() {
    const b = getMemoryStore().store({
      agentId: agentA,
      scope: "swarm",
      name: "get-b-target",
      content: "target memory B",
      source: "manual",
    });
    const a = getMemoryStore().store({
      agentId: agentA,
      scope: "swarm",
      name: "get-a-source",
      content: "See [[get-b-target]].",
      source: "manual",
    });
    storeLinks(a.id, agentA, a.content);
    return { a, b };
  }

  test("returns links and backlinks blocks", async () => {
    const { a, b } = seedLinkedPair();

    const forA = (await buildTool().handler(
      { memoryId: a.id, intent: "test links block" },
      meta(agentA),
    )) as StructuredResult;
    expect(forA.structuredContent.links).toHaveLength(1);
    expect(forA.structuredContent.links?.[0]).toMatchObject({
      linkType: "wikilink",
      targetId: b.id,
      resolved: true,
      target: { id: b.id, name: "get-b-target", scope: "swarm" },
    });
    expect(forA.structuredContent.backlinks).toHaveLength(0);

    const forB = (await buildTool().handler(
      { memoryId: b.id, intent: "test backlinks block" },
      meta(agentA),
    )) as StructuredResult;
    expect(forB.structuredContent.links).toHaveLength(0);
    expect(forB.structuredContent.backlinks).toHaveLength(1);
    expect(forB.structuredContent.backlinks?.[0]?.from.id).toBe(a.id);
  });

  test("does not leak cross-agent agent-scoped backlinks; leads see all", async () => {
    const b = getMemoryStore().store({
      agentId: agentA,
      scope: "swarm",
      name: "get-b-target",
      content: "target memory B",
      source: "manual",
    });
    const priv = getMemoryStore().store({
      agentId: agentA,
      scope: "agent",
      name: "get-private-source",
      content: "Private note about [[get-b-target]].",
      source: "manual",
    });
    storeLinks(priv.id, agentA, priv.content);

    // Non-lead agentC must not see agentA's private backlink.
    const forC = (await buildTool().handler(
      { memoryId: b.id, intent: "test backlink ACL" },
      meta(agentC),
    )) as StructuredResult;
    expect(forC.structuredContent.success).toBe(true);
    expect(forC.structuredContent.backlinks).toHaveLength(0);

    // The owner sees it.
    const forA = (await buildTool().handler(
      { memoryId: b.id, intent: "test backlink ACL owner" },
      meta(agentA),
    )) as StructuredResult;
    expect(forA.structuredContent.backlinks).toHaveLength(1);

    // agentB is a lead — leads see all.
    const forLead = (await buildTool().handler(
      { memoryId: b.id, intent: "test backlink ACL lead" },
      meta(agentB),
    )) as StructuredResult;
    expect(forLead.structuredContent.backlinks).toHaveLength(1);
    expect(forLead.structuredContent.backlinks?.[0]?.from.id).toBe(priv.id);
  });

  test("HTTP GET /api/memory/{id} includes links and backlinks", async () => {
    const { a, b } = seedLinkedPair();

    async function httpGet(id: string) {
      const req = {
        method: "GET",
        url: `/api/memory/${id}`,
        headers: {},
      } as unknown as IncomingMessage;
      const captured = { status: 0, body: "" };
      const res = {
        writeHead(status: number) {
          captured.status = status;
          return this;
        },
        end(chunk?: string) {
          if (chunk) captured.body = chunk;
          return this;
        },
      } as unknown as ServerResponse;
      const handled = await handleMemory(req, res, getPathSegments(req.url || ""), agentA);
      expect(handled).toBe(true);
      return JSON.parse(captured.body) as {
        memory: AgentMemory;
        links: MemoryLinkView[];
        backlinks: MemoryBacklinkView[];
      };
    }

    const bodyA = await httpGet(a.id);
    expect(bodyA.memory.id).toBe(a.id);
    expect(bodyA.links).toHaveLength(1);
    expect(bodyA.links[0]).toMatchObject({ targetId: b.id, resolved: true });
    expect(bodyA.backlinks).toHaveLength(0);

    const bodyB = await httpGet(b.id);
    expect(bodyB.links).toHaveLength(0);
    expect(bodyB.backlinks).toHaveLength(1);
    expect(bodyB.backlinks[0]?.from.id).toBe(a.id);
  });
});
