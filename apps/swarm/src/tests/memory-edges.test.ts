/**
 * Tests for the memory-rater v1.5 step-6 wedge — `references-source` edges.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-6.md §9
 *
 * Covers:
 *   - applyRating UPSERT into agent_memory_edge (single, repeated, distinct).
 *   - Q2 free-form contract — `linear:DES-187`, `customer:crabi`,
 *     `anything:goes-12345` all accepted; no prefix gating.
 *   - Q2 sanitization — NUL byte rejected, 513-char rejected, control chars
 *     stripped.
 *   - DB CHECK constraint trips for `type='supersedes'` (raw sqlite path).
 *   - HTTP `GET /api/memory/edges?memoryId=` happy + 400 paths.
 *   - `memory_rate` MCP tool round-trip with `referencesSource`.
 *   - LlmRater `buildRatingsFromLlm` propagation + sanitization.
 *   - Negative path: no edge row created when `referencesSource` is omitted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Subprocess } from "bun";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { listEdgesForAgent } from "../be/memory/edges-store";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { buildRatingsFromLlm } from "../be/memory/raters/llm";
import { applyRating } from "../be/memory/raters/store";
import { REFERENCES_SOURCE_MAX_LENGTH, sanitizeReferencesSource } from "../be/memory/raters/types";
import { registerMemoryRateTool } from "../tools/memory-rate";

const TEST_PORT = 19127;
const TEST_DB_PATH = `/tmp/test-memory-edges-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-key";

let serverProc: Subprocess;
const agentA = randomUUID();
const agentB = randomUUID();
const taskA = randomUUID();
let store: SqliteMemoryStore;

const testTemplateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedEdgesTemplate?: Uint8Array;
};

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; agentId?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (opts.agentId) headers["x-agent-id"] = opts.agentId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not ready
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

function makeMemory(
  name: string,
  agentId = agentA,
  scope: "agent" | "swarm" = "agent",
): {
  id: string;
} {
  return store.store({
    agentId,
    scope,
    name,
    content: `${name} content`,
    source: "manual",
  });
}

function insertRetrieval(taskId: string, agentId: string, memoryId: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_retrieval (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt)
       VALUES (?, ?, ?, NULL, ?, 0.85, ?)`,
    )
    .run(randomUUID(), taskId, agentId, memoryId, new Date().toISOString());
}

function readPosterior(id: string): { alpha: number; beta: number } {
  const row = getDb()
    .prepare<{ alpha: number; beta: number }, [string]>(
      "SELECT alpha, beta FROM agent_memory WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`memory ${id} not found`);
  return { alpha: row.alpha, beta: row.beta };
}

function readEdges(
  memoryId: string,
): { to_id: string; type: string; alpha: number; beta: number }[] {
  return getDb()
    .prepare<{ to_id: string; type: string; alpha: number; beta: number }, [string]>(
      "SELECT to_id, type, alpha, beta FROM agent_memory_edge WHERE from_id = ? ORDER BY to_id",
    )
    .all(memoryId);
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }

  serverProc = Bun.spawn(["bun", "apps/swarm/src/http.ts"], {
    cwd: `${import.meta.dir}/../../../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY,
      CAPABILITIES: "core",
      SLACK_BOT_TOKEN: "",
      LINEAR_DISABLE: "true",
      JIRA_DISABLE: "true",
      GITHUB_DISABLE: "true",
      SLACK_DISABLE: "true",
      HEARTBEAT_DISABLE: "true",
      OAUTH_KEEPALIVE_DISABLE: "true",
      ANONYMIZED_TELEMETRY: "false",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitForServer(`${BASE}/health`);

  testTemplateGlobals.__savedEdgesTemplate = testTemplateGlobals.__testMigrationTemplate;
  testTemplateGlobals.__testMigrationTemplate = undefined;
  // Close any leftover in-memory DB from a prior test in the same Bun worker.
  // initDb is a no-op when `db` is already set, so without this the test
  // process keeps writing to the previous template-restored DB while the
  // spawned server reads from TEST_DB_PATH — cross-process WAL visibility
  // breaks and `applied=0` / 400 / empty edge lists ensue.
  closeDb();
  initDb(TEST_DB_PATH);
  createAgent({ id: agentA, name: "Agent A", isLead: false, status: "idle" });
  createAgent({ id: agentB, name: "Agent B", isLead: false, status: "idle" });

  const insertTask = getDb().prepare(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
  );
  const now = new Date().toISOString();
  insertTask.run(taskA, agentA, "task A", now, now);

  store = new SqliteMemoryStore();
}, 20000);

afterAll(async () => {
  closeDb();
  testTemplateGlobals.__testMigrationTemplate = testTemplateGlobals.__savedEdgesTemplate;
  testTemplateGlobals.__savedEdgesTemplate = undefined;
  if (serverProc) {
    serverProc.kill();
    try {
      await serverProc.exited;
    } catch {}
  }
  await Bun.sleep(50);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

beforeEach(() => {
  getDb().run("DELETE FROM memory_rating");
  getDb().run("DELETE FROM memory_retrieval");
  getDb().run("DELETE FROM agent_memory_edge");
  getDb().run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
});

describe("applyRating + agent_memory_edge UPSERT", () => {
  test("first event creates the edge row with deltas matching the memory row", () => {
    const m = makeMemory("ref-1");
    const result = applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "github:foo/bar#1",
      },
    ]);
    expect(result.applied).toBe(1);
    expect(readPosterior(m.id)).toEqual({ alpha: 2, beta: 1 });

    const edges = readEdges(m.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      to_id: "github:foo/bar#1",
      type: "references-source",
      alpha: 2,
      beta: 1,
    });
  });

  test("repeated event with the same referencesSource updates the existing row in place", () => {
    const m = makeMemory("ref-rep");
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 0.5,
        source: "llm",
        referencesSource: "github:foo/bar#1",
      },
    ]);
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 0.25,
        source: "llm",
        referencesSource: "github:foo/bar#1",
      },
    ]);
    const edges = readEdges(m.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.alpha).toBeCloseTo(1 + 0.5 + 0.25, 5);
    expect(edges[0]!.beta).toBe(1);
  });

  test("different referencesSource for the same memory creates two distinct edge rows", () => {
    const m = makeMemory("ref-distinct");
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "github:foo/bar#1",
      },
    ]);
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "linear:DES-187",
      },
    ]);
    const edges = readEdges(m.id);
    expect(edges).toHaveLength(2);
    const ids = edges.map((e) => e.to_id).sort();
    expect(ids).toEqual(["github:foo/bar#1", "linear:DES-187"]);
  });

  test("Q2 free-form: linear, customer, and arbitrary prefixes all accepted", () => {
    const m = makeMemory("ref-freeform");
    const sources = ["linear:DES-187", "customer:crabi", "anything:goes-12345"];
    for (const referencesSource of sources) {
      applyRating([
        {
          memoryId: m.id,
          signal: 1,
          weight: 1,
          source: "llm",
          referencesSource,
        },
      ]);
    }
    const edges = readEdges(m.id);
    expect(edges).toHaveLength(3);
    const ids = edges.map((e) => e.to_id).sort();
    expect(ids).toEqual(sources.slice().sort());
  });

  test("event without referencesSource → memory updated, no edge row", () => {
    const m = makeMemory("ref-none");
    const result = applyRating([{ memoryId: m.id, signal: 1, weight: 1, source: "llm" }]);
    expect(result.applied).toBe(1);
    expect(readPosterior(m.id)).toEqual({ alpha: 2, beta: 1 });
    expect(readEdges(m.id)).toEqual([]);
  });

  test("over-cap referencesSource (513 chars) → applyRating rejects, no edge or memory mutation", () => {
    const m = makeMemory("ref-overcap");
    const result = applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "x".repeat(REFERENCES_SOURCE_MAX_LENGTH + 1),
      },
    ]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/exceeds/);
    expect(readPosterior(m.id)).toEqual({ alpha: 1, beta: 1 });
    expect(readEdges(m.id)).toEqual([]);
  });

  test("referencesSource with embedded NUL → applyRating rejects", () => {
    const m = makeMemory("ref-nul");
    const result = applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: `github:foo/bar#1${String.fromCharCode(0)}`,
      },
    ]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/NUL/);
    expect(readEdges(m.id)).toEqual([]);
  });
});

describe("DB CHECK constraint", () => {
  test("INSERT with type='supersedes' raises SQLITE_CONSTRAINT (v2 guardrail)", () => {
    const m = makeMemory("check-supersedes");
    expect(() => {
      getDb().run(
        `INSERT INTO agent_memory_edge (from_id, to_id, type, alpha, beta, createdAt)
         VALUES (?, ?, 'supersedes', 1, 1, ?)`,
        [m.id, "memory:other", new Date().toISOString()],
      );
    }).toThrow(/CHECK|constraint/i);
  });
});

describe("sanitizeReferencesSource (Q2)", () => {
  test("strips control characters, preserves printable ASCII", () => {
    const cleaned = sanitizeReferencesSource(
      `github:foo/bar#1${String.fromCharCode(7)}${String.fromCharCode(127)}`,
    );
    expect(cleaned).toBe("github:foo/bar#1");
  });

  test("rejects strings containing a NUL byte", () => {
    expect(sanitizeReferencesSource(`a${String.fromCharCode(0)}b`)).toBeNull();
  });

  test("rejects strings that strip to empty", () => {
    expect(sanitizeReferencesSource(String.fromCharCode(7).repeat(5))).toBeNull();
  });
});

describe("buildRatingsFromLlm propagation (step-6 §6)", () => {
  test("propagates valid referencesSource through to RatingEvent", () => {
    const events = buildRatingsFromLlm(
      [
        {
          id: "m-1",
          score: 1,
          reasoning: "useful",
          referencesSource: "linear:DES-187",
        },
      ],
      [{ id: "m-1" }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.referencesSource).toBe("linear:DES-187");
  });

  test("drops referencesSource when it sanitizes to null (NUL byte) but keeps the rating", () => {
    const events = buildRatingsFromLlm(
      [
        {
          id: "m-1",
          score: 0.8,
          reasoning: "useful with bad ref",
          referencesSource: `linear:DES-187${String.fromCharCode(0)}`,
        },
      ],
      [{ id: "m-1" }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.referencesSource).toBeUndefined();
    expect(events[0]!.signal).toBeCloseTo(2 * 0.8 - 1, 5);
  });

  test("omits referencesSource when not provided (default behaviour)", () => {
    const events = buildRatingsFromLlm(
      [{ id: "m-1", score: 1, reasoning: "useful" }],
      [{ id: "m-1" }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.referencesSource).toBeUndefined();
  });
});

describe("POST /api/memory/rate with referencesSource (step-6 §4)", () => {
  test("happy path: referencesSource accepted → edge row created", async () => {
    const m = makeMemory("http-rate-1");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [
          {
            memoryId: m.id,
            signal: 1,
            weight: 1,
            source: "llm",
            taskId: taskA,
            referencesSource: "github:desplega-ai/agent-swarm#377",
          },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(1);
    const edges = readEdges(m.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to_id).toBe("github:desplega-ai/agent-swarm#377");
  });

  test("Q2 free-form positives (linear/customer/anything) all accepted via HTTP", async () => {
    const m = makeMemory("http-rate-freeform");
    for (const referencesSource of ["linear:DES-187", "customer:crabi", "anything:goes-12345"]) {
      const r = await api("POST", "/api/memory/rate", {
        agentId: agentA,
        body: {
          events: [
            {
              memoryId: m.id,
              signal: 1,
              weight: 1,
              source: "llm",
              taskId: taskA,
              referencesSource,
            },
          ],
        },
      });
      expect(r.status).toBe(200);
      expect(r.body.applied).toBe(1);
    }
    const edges = readEdges(m.id);
    expect(edges).toHaveLength(3);
  });

  test("513-char referencesSource → 400 (Zod cap)", async () => {
    const m = makeMemory("http-rate-overcap");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [
          {
            memoryId: m.id,
            signal: 1,
            weight: 1,
            source: "llm",
            taskId: taskA,
            referencesSource: "x".repeat(REFERENCES_SOURCE_MAX_LENGTH + 1),
          },
        ],
      },
    });
    expect(r.status).toBe(400);
    expect(readEdges(m.id)).toEqual([]);
  });

  test("embedded NUL → 400 (Zod transform rejects)", async () => {
    const m = makeMemory("http-rate-nul");
    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [
          {
            memoryId: m.id,
            signal: 1,
            weight: 1,
            source: "llm",
            taskId: taskA,
            referencesSource: `github:foo/bar#1${String.fromCharCode(0)}`,
          },
        ],
      },
    });
    expect(r.status).toBe(400);
    expect(readEdges(m.id)).toEqual([]);
  });
});

describe("GET /api/memory/edges (step-6 §7)", () => {
  test("returns edges with computed usefulness", async () => {
    const m = makeMemory("get-edges-1");
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 0.5,
        source: "llm",
        referencesSource: "github:foo/bar#1",
      },
    ]);

    const r = await api("GET", `/api/memory/edges?memoryId=${m.id}`, { agentId: agentA });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.edges)).toBe(true);
    expect(r.body.edges).toHaveLength(1);
    expect(r.body.edges[0]).toMatchObject({
      to: "github:foo/bar#1",
      type: "references-source",
    });
    expect(r.body.edges[0].alpha).toBeCloseTo(1.5, 5);
    expect(r.body.edges[0].beta).toBe(1);
    // usefulness = clamp(2 * 1.5/(1.5+1), 1.0, 2.0) = 1.2
    expect(r.body.edges[0].usefulness).toBeCloseTo(1.2, 5);
    expect(typeof r.body.edges[0].createdAt).toBe("string");
  });

  test("returns empty array when memory has no edges", async () => {
    const m = makeMemory("get-edges-empty");
    const r = await api("GET", `/api/memory/edges?memoryId=${m.id}`, { agentId: agentA });
    expect(r.status).toBe(200);
    expect(r.body.edges).toEqual([]);
  });

  test("missing memoryId → 400", async () => {
    const r = await api("GET", "/api/memory/edges", { agentId: agentA });
    expect(r.status).toBe(400);
  });

  test("missing X-Agent-ID → 400", async () => {
    const m = makeMemory("get-edges-noauth");
    const r = await api("GET", `/api/memory/edges?memoryId=${m.id}`);
    expect(r.status).toBe(400);
  });

  test("agent-scope memory owned by another agent → empty (defence-in-depth)", async () => {
    const m = makeMemory("get-edges-other-owner", agentB);
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "github:other/repo#1",
      },
    ]);
    const r = await api("GET", `/api/memory/edges?memoryId=${m.id}`, { agentId: agentA });
    expect(r.status).toBe(200);
    expect(r.body.edges).toEqual([]);
  });

  test("swarm-scope memory is visible to any agent", async () => {
    const m = makeMemory("get-edges-swarm", agentB, "swarm");
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "github:swarm/repo#1",
      },
    ]);
    const r = await api("GET", `/api/memory/edges?memoryId=${m.id}`, { agentId: agentA });
    expect(r.status).toBe(200);
    expect(r.body.edges).toHaveLength(1);
    expect(r.body.edges[0].to).toBe("github:swarm/repo#1");
  });
});

describe("listEdgesForAgent (in-process)", () => {
  test("returns empty for unknown memory id", () => {
    expect(listEdgesForAgent(agentA, randomUUID())).toEqual([]);
  });

  test("clamps usefulness to [1.0, 2.0]", () => {
    const m = makeMemory("usefulness-clamp");
    applyRating([
      {
        memoryId: m.id,
        signal: 1,
        weight: 1,
        source: "llm",
        referencesSource: "github:foo/bar#1",
      },
    ]);
    const edges = listEdgesForAgent(agentA, m.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.usefulness).toBeGreaterThanOrEqual(1.0);
    expect(edges[0]!.usefulness).toBeLessThanOrEqual(2.0);
  });
});

describe("memory_rate MCP tool with referencesSource (step-6 §5)", () => {
  type FetchInit = Parameters<typeof fetch>[1];
  type CallRecord = { url: string; init: FetchInit };
  const originalFetch = globalThis.fetch;

  function installFetchStub(
    responder: (url: string, init: FetchInit) => Response | Promise<Response>,
  ): { calls: CallRecord[] } {
    const calls: CallRecord[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: FetchInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
      calls.push({ url, init: init ?? {} });
      return responder(url, init ?? {});
    }) as typeof fetch;
    return { calls };
  }

  function buildServer() {
    const server = new McpServer({ name: "memory-rate-test", version: "1.0.0" });
    registerMemoryRateTool(server);
    type RegisteredTool = {
      handler: (args: unknown, extra: unknown) => Promise<unknown>;
    };
    const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const tool = registered.memory_rate;
    if (!tool) throw new Error("memory_rate tool not registered");
    return { tool };
  }

  const fakeMeta = {
    sessionId: "session-123",
    requestInfo: {
      headers: {
        "x-agent-id": "agent-abc",
        "x-source-task-id": "11111111-1111-4111-8111-111111111111",
      },
    },
  };
  const fakeMemoryId = "22222222-2222-4222-8222-222222222222";

  test("forwards referencesSource in the POST body when provided", async () => {
    const { tool } = buildServer();
    const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
    try {
      const result = (await tool.handler(
        { id: fakeMemoryId, useful: true, referencesSource: "linear:DES-187" },
        fakeMeta,
      )) as { structuredContent: { success: boolean } };
      expect(result.structuredContent.success).toBe(true);
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.events[0].referencesSource).toBe("linear:DES-187");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects NUL-byte referencesSource without POSTing", async () => {
    const { tool } = buildServer();
    const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
    try {
      const result = (await tool.handler(
        {
          id: fakeMemoryId,
          useful: true,
          referencesSource: `linear:DES-187${String.fromCharCode(0)}`,
        },
        fakeMeta,
      )) as { structuredContent: { success: boolean; message: string } };
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toMatch(/NUL/);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("end-to-end: rate + retrieval row → 200 + edge row exists", async () => {
    const m = makeMemory("mcp-roundtrip");
    insertRetrieval(taskA, agentA, m.id);

    const r = await api("POST", "/api/memory/rate", {
      agentId: agentA,
      body: {
        events: [
          {
            memoryId: m.id,
            signal: 1,
            weight: 1,
            source: "explicit-self",
            taskId: taskA,
            referencesSource: "github:desplega-ai/agent-swarm#377",
          },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(1);
    expect(readEdges(m.id)).toHaveLength(1);
  });
});
