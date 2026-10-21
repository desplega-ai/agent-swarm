import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { taskCompletionMemoryKey } from "../be/memory/index-content";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { countCandidateDocuments, searchMemoryCandidates } from "../be/memory/search-candidates";

// Candidate starvation (PR #2302 review): rerank() collapses the chunks of one
// task_completion document, but the store's candidate window (limit x 3) is
// cut before the collapse. 32 high-similarity chunks of one task filled the
// whole window, so limit 3 returned one result while five relevant manual
// memories sat past the cutoff. Everything below the query embedding is real:
// the SQLite store (vec and hybrid paths), the HTTP routes and the MCP tool.
//
// The 128-chunk document is the round-2 case: the hybrid and FTS arms capped
// their fetch at 100 rows, so widening past 100 returned the same rows and
// read as exhaustion while the manual memories sat behind chunk 100.

/** Unit vector: `cos` on axis 2 (the query axis), the remainder on `axis`. */
function mix(cos: number, axis: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[2] = cos;
  embedding[axis] = Math.sqrt(1 - cos * cos);
  return embedding;
}

const queryEmbedding = mix(1, 3);

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test",
    dimensions: 512,
    embed: async () => queryEmbedding,
    embedBatch: async (texts: string[]) => texts.map(() => queryEmbedding),
    isConfigured: () => true,
  }),
  getMemoryStore: () => new SqliteMemoryStore(),
}));

const { handleMemory } = await import("../http/memory");
const { registerMemorySearchTool } = await import("../tools/memory-search");

const TEST_DB_PATH = "./test-memory-chunked-search-starvation.sqlite";
const QUERY = "starvation probe";
const MANUAL_DOCS = 5;
const LIMIT = 3;
let prevHybridFlag: string | undefined;

/** One agent per chunk count: agent-scope rows keep the scenarios apart. */
const scenarios = [32, 128].map((chunks) => ({
  chunks,
  agentId: randomUUID(),
  manualIds: new Set<string>(),
}));

async function postJson(agentId: string, url: string, segments: string[]): Promise<string[]> {
  const body = { query: QUERY, limit: LIMIT };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = {};
  let payload: { results: { id: string }[] } = { results: [] };
  const res = {
    writeHead() {
      return this;
    },
    end(chunk?: unknown) {
      payload = typeof chunk === "string" ? JSON.parse(chunk) : (chunk as typeof payload);
      return this;
    },
  } as unknown as ServerResponse;
  expect(await handleMemory(req, res, segments, agentId)).toBe(true);
  return payload.results.map((r) => r.id);
}

const searchHttp = (agentId: string) =>
  postJson(agentId, "/api/memory/search", ["api", "memory", "search"]);
const listHttp = (agentId: string) =>
  postJson(agentId, "/api/memory/list", ["api", "memory", "list"]);

async function searchTool(agentId: string): Promise<string[]> {
  const server = new McpServer({ name: "chunked-search-starvation", version: "1.0.0" });
  registerMemorySearchTool(server);
  const tool = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: unknown,
            extra: unknown,
          ) => Promise<{ structuredContent: { results: { id: string }[] } }>;
        }
      >;
    }
  )._registeredTools["memory-search"]!;
  const result = await tool.handler(
    { query: QUERY, limit: LIMIT, scope: "all" },
    { sessionId: "starvation", requestInfo: { headers: { "x-agent-id": agentId } } },
  );
  return result.structuredContent.results.map((r) => r.id);
}

beforeAll(async () => {
  prevHybridFlag = process.env.MEMORY_HYBRID_SEARCH;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  const store = new SqliteMemoryStore();
  for (const { chunks, agentId, manualIds } of scenarios) {
    await createAgent({
      id: agentId,
      name: `Starvation Agent ${chunks}`,
      isLead: false,
      status: "idle",
    });
    const taskKey = taskCompletionMemoryKey(randomUUID());
    // One long task output, every chunk closer to the query than any manual
    // memory.
    for (let i = 0; i < chunks; i++) {
      const chunk = await store.store({
        agentId,
        scope: "agent",
        name: "Task: long dreaming run",
        content: `${QUERY} chunk ${i}: ${"lane starvation probe finding ".repeat(4)}`,
        source: "task_completion",
        key: taskKey,
        chunkIndex: i,
        totalChunks: chunks,
      });
      await store.updateEmbedding(chunk.id, mix(0.99 - i * 0.0001, 10 + i), "test");
    }
    for (let j = 0; j < MANUAL_DOCS; j++) {
      const doc = await store.store({
        agentId,
        scope: "agent",
        name: `manual note ${j}`,
        content: `${QUERY} manual note ${j}`,
        source: "manual",
      });
      manualIds.add(doc.id);
      await store.updateEmbedding(doc.id, mix(0.8 - j * 0.01, 300 + j), "test");
    }
  }
});

afterEach(() => {
  if (prevHybridFlag === undefined) delete process.env.MEMORY_HYBRID_SEARCH;
  else process.env.MEMORY_HYBRID_SEARCH = prevHybridFlag;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("chunks of one task do not starve the result set", () => {
  for (const { chunks, agentId, manualIds } of scenarios) {
    for (const hybrid of ["0", "1"]) {
      for (const [surface, search] of [
        ["POST /api/memory/search", searchHttp],
        ["POST /api/memory/list", listHttp],
        ["memory-search tool", searchTool],
      ] as const) {
        test(`${chunks} chunks, ${surface}, hybrid=${hybrid}: limit ${LIMIT} returns ${LIMIT} documents`, async () => {
          process.env.MEMORY_HYBRID_SEARCH = hybrid;
          const ids = await search(agentId);
          expect(ids).toHaveLength(LIMIT);
          expect(new Set(ids).size).toBe(LIMIT);
          // At most one slot for the task document; the rest are manual memories.
          expect(ids.filter((id) => !manualIds.has(id)).length).toBeLessThanOrEqual(1);
        });
      }
    }
  }

  test("FTS-only path (no query embedding) widens past 100 chunks of one task", async () => {
    const { agentId, manualIds } = scenarios[1]!;
    // A missing query embedding routes the store to searchFts.
    const candidates = await searchMemoryCandidates(
      new SqliteMemoryStore(),
      new Float32Array(0),
      agentId,
      { limit: LIMIT, queryText: QUERY, scope: "all" },
    );
    expect(countCandidateDocuments(candidates)).toBeGreaterThanOrEqual(LIMIT);
    expect(candidates.filter((c) => manualIds.has(c.id)).length).toBeGreaterThan(0);
  });
});
