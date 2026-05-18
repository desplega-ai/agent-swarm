/**
 * KV MCP tools — unit-level coverage. Registers each tool against a fresh
 * McpServer, pulls handlers out of the SDK registry, invokes them with a
 * stubbed `requestInfo` (mirrors create-page-tool.test.ts).
 *
 * Verifies:
 *   - kv-set / kv-get round-trip on the auto-resolved agent namespace
 *   - kv-incr atomicity + 'integer' coercion
 *   - kv-list shape (entries, total, namespace)
 *   - kv-delete returns deleted flag
 *   - cross-agent write 403 (lead bypass tested too)
 *   - missing namespace + no agent header → structured error
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import {
  registerKvDeleteTool,
  registerKvGetTool,
  registerKvIncrTool,
  registerKvListTool,
  registerKvSetTool,
} from "../tools/kv";

const TEST_DB_PATH = "./test-kv-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function buildServer() {
  const server = new McpServer({ name: "kv-tool-test", version: "1.0.0" });
  registerKvGetTool(server);
  registerKvSetTool(server);
  registerKvDeleteTool(server);
  registerKvIncrTool(server);
  registerKvListTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return {
    get: registered["kv-get"]!,
    set: registered["kv-set"]!,
    del: registered["kv-delete"]!,
    incr: registered["kv-incr"]!,
    list: registered["kv-list"]!,
  };
}

function meta(agentId: string | undefined, sourceTaskId?: string) {
  const headers: Record<string, string> = {};
  if (agentId !== undefined) headers["x-agent-id"] = agentId;
  if (sourceTaskId !== undefined) headers["x-source-task-id"] = sourceTaskId;
  return { sessionId: "s1", requestInfo: { headers } };
}

type StructuredResult<T> = { structuredContent: T };

let agentA: string;
let agentB: string;
let lead: string;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  const a = createAgent({ name: "kv-tool-a", isLead: false, status: "idle" });
  const b = createAgent({ name: "kv-tool-b", isLead: false, status: "idle" });
  const l = createAgent({ name: "kv-tool-lead", isLead: true, status: "idle" });
  agentA = a.id;
  agentB = b.id;
  lead = l.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries");
});

describe("kv MCP tools", () => {
  test("kv-set + kv-get round-trip on agent namespace", async () => {
    const tools = buildServer();
    const setRes = (await tools.set.handler(
      { key: "k1", value: { hello: "world" } },
      meta(agentA),
    )) as StructuredResult<{
      success: boolean;
      namespace: string;
      entry: { value: unknown; valueType: string };
    }>;
    expect(setRes.structuredContent.success).toBe(true);
    expect(setRes.structuredContent.namespace).toBe(`task:agent:${agentA}`);
    expect(setRes.structuredContent.entry.value).toEqual({ hello: "world" });

    const getRes = (await tools.get.handler({ key: "k1" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      entry: { value: unknown } | null;
    }>;
    expect(getRes.structuredContent.success).toBe(true);
    expect(getRes.structuredContent.entry?.value).toEqual({ hello: "world" });
  });

  test("kv-get returns entry=null for missing keys", async () => {
    const tools = buildServer();
    const getRes = (await tools.get.handler({ key: "nope" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      entry: unknown | null;
    }>;
    expect(getRes.structuredContent.success).toBe(true);
    expect(getRes.structuredContent.entry).toBeNull();
  });

  test("kv-incr creates + increments + reports value", async () => {
    const tools = buildServer();
    const r1 = (await tools.incr.handler({ key: "ctr", by: 5 }, meta(agentA))) as StructuredResult<{
      entry: { value: number; valueType: string };
    }>;
    expect(r1.structuredContent.entry.value).toBe(5);
    expect(r1.structuredContent.entry.valueType).toBe("integer");
    const r2 = (await tools.incr.handler({ key: "ctr" }, meta(agentA))) as StructuredResult<{
      entry: { value: number };
    }>;
    expect(r2.structuredContent.entry.value).toBe(6);
  });

  test("kv-incr returns structured error on valueType collision", async () => {
    const tools = buildServer();
    await tools.set.handler({ key: "obj", value: { n: 1 } }, meta(agentA));
    const r = (await tools.incr.handler({ key: "obj" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      message: string;
    }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/Cannot INCR/);
  });

  test("kv-list returns entries + total + namespace", async () => {
    const tools = buildServer();
    await tools.set.handler({ key: "a-1", value: 1, valueType: "integer" }, meta(agentA));
    await tools.set.handler({ key: "a-2", value: 2, valueType: "integer" }, meta(agentA));
    await tools.set.handler({ key: "b-1", value: 3, valueType: "integer" }, meta(agentA));

    const r = (await tools.list.handler({ prefix: "a-" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      entries: { key: string }[];
      total: number;
      namespace: string;
    }>;
    expect(r.structuredContent.entries.map((e) => e.key)).toEqual(["a-1", "a-2"]);
    expect(r.structuredContent.total).toBe(2);
    expect(r.structuredContent.namespace).toBe(`task:agent:${agentA}`);
  });

  test("kv-delete returns deleted flag", async () => {
    const tools = buildServer();
    await tools.set.handler({ key: "del-me", value: "x", valueType: "string" }, meta(agentA));
    const r1 = (await tools.del.handler({ key: "del-me" }, meta(agentA))) as StructuredResult<{
      deleted: boolean;
    }>;
    expect(r1.structuredContent.deleted).toBe(true);
    const r2 = (await tools.del.handler({ key: "del-me" }, meta(agentA))) as StructuredResult<{
      deleted: boolean;
    }>;
    expect(r2.structuredContent.deleted).toBe(false);
  });

  test("cross-agent write is rejected for non-lead callers", async () => {
    const tools = buildServer();
    const r = (await tools.set.handler(
      { key: "k", value: 1, namespace: `task:agent:${agentB}` },
      meta(agentA),
    )) as StructuredResult<{ success: boolean; message: string }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/lead/);
  });

  test("lead can write to another agent's namespace", async () => {
    const tools = buildServer();
    const r = (await tools.set.handler(
      { key: "k", value: 1, namespace: `task:agent:${agentB}`, valueType: "integer" },
      meta(lead),
    )) as StructuredResult<{ success: boolean; namespace: string }>;
    expect(r.structuredContent.success).toBe(true);
    expect(r.structuredContent.namespace).toBe(`task:agent:${agentB}`);
  });

  test("missing agent header → namespace cannot be resolved", async () => {
    const tools = buildServer();
    const r = (await tools.get.handler({ key: "k" }, meta(undefined))) as StructuredResult<{
      success: boolean;
      message: string;
    }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/namespace/);
  });

  test("page namespace writes are rejected (MCP can't be a page)", async () => {
    const tools = buildServer();
    const r = (await tools.set.handler(
      { key: "k", value: 1, namespace: "task:page:doesntmatter" },
      meta(agentA),
    )) as StructuredResult<{ success: boolean; message: string }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/page-proxy/);
  });
});
