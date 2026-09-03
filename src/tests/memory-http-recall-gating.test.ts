import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import * as realMemoryModule from "../be/memory";
import { sourceQuality } from "../be/memory/reranker";
import { SIMILARITY_THRESHOLD } from "../prompts/memories";
import type { AgentMemory } from "../types";

// Capture the real exports BEFORE mock.module patches the registry entry —
// plain object properties are immune to the mock's live-binding rewrite.
const realMemoryExports = {
  getEmbeddingProvider: realMemoryModule.getEmbeddingProvider,
  getMemoryStore: realMemoryModule.getMemoryStore,
};

const memoryId = randomUUID();
const memoryChunkId = randomUUID();
const thresholdMemoryId = randomUUID();
const agentId = randomUUID();
const sourceTaskId = randomUUID();
const TEST_DB_PATH = "./test-memory-http-recall-gating.sqlite";

const memory: AgentMemory = {
  id: memoryId,
  agentId,
  key: "ui-memory-fixture",
  content: "UI browse/search memory fixture",
  name: "ui-memory-fixture",
  scope: "agent",
  source: "manual",
  summary: null,
  sourcePath: null,
  sourceTaskId: null,
  chunkIndex: 0,
  totalChunks: 1,
  tags: [],
  contextKey: null,
  createdAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
  accessedAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
};

const memoryChunk: AgentMemory = {
  ...memory,
  id: memoryChunkId,
  content: "UI browse/search memory fixture second chunk",
  chunkIndex: 1,
  totalChunks: 2,
};

const thresholdMemory: AgentMemory = {
  ...memory,
  id: thresholdMemoryId,
  key: "threshold-memory-fixture",
  name: "threshold-memory-fixture",
  content: "Prompt threshold control",
};

function candidate(memoryFixture: AgentMemory, similarity: number) {
  return {
    ...memoryFixture,
    similarity,
    rawSimilarity: similarity,
    compositeScore: similarity,
    accessCount: 0,
    expiresAt: null,
    embeddingModel: "test-embedding",
    alpha: 1,
    beta: 1,
  };
}

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test-embedding",
    dimensions: 3,
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
  }),
  getMemoryStore: () => ({
    store: async (
      input: import("../be/memory/types").MemoryInput,
    ): Promise<import("../types").AgentMemory> => {
      const { SqliteMemoryStore } =
        require("../be/memory/providers/sqlite-store") as typeof import("../be/memory/providers/sqlite-store");
      return new SqliteMemoryStore().store(input);
    },
    get: async (id: string) => {
      if (id === memory.id) return memory;
      const { SqliteMemoryStore } =
        require("../be/memory/providers/sqlite-store") as typeof import("../be/memory/providers/sqlite-store");
      return new SqliteMemoryStore().get(id);
    },
    peek: async (id: string) => {
      if (id === memory.id) return memory;
      const { SqliteMemoryStore } =
        require("../be/memory/providers/sqlite-store") as typeof import("../be/memory/providers/sqlite-store");
      return new SqliteMemoryStore().peek(id);
    },
    search: async (
      _embedding: Float32Array,
      _agentId: string,
      options: import("../be/memory/types").MemorySearchOptions,
    ) => {
      if (options.queryText === "document recall") {
        return [candidate(memory, 0.95), candidate(memoryChunk, 0.9)];
      }
      if (options.queryText === "prompt recall") {
        return [
          candidate(memory, 0.95),
          candidate(thresholdMemory, SIMILARITY_THRESHOLD / sourceQuality(thresholdMemory.source)),
        ];
      }
      return [candidate(memory, 0.95)];
    },
  }),
}));

const { handleMemory } = await import("../http/memory");

type ResponseCapture = {
  statusCode: number;
  body: any;
};

function makeReq(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function makeRes(capture: ResponseCapture): ServerResponse {
  return {
    writeHead(statusCode: number) {
      capture.statusCode = statusCode;
      return this;
    },
    end(chunk?: unknown) {
      capture.body = typeof chunk === "string" ? JSON.parse(chunk) : chunk;
      return this;
    },
  } as ServerResponse;
}

async function callMemoryRoute(
  method: string,
  url: string,
  pathSegments: string[],
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseCapture> {
  const capture: ResponseCapture = { statusCode: 0, body: null };
  const handled = await handleMemory(
    makeReq(method, url, body, headers),
    makeRes(capture),
    pathSegments,
    agentId,
  );
  expect(handled).toBe(true);
  return capture;
}

async function countRetrievals(): Promise<number> {
  return (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_retrieval"))!.n;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }

  initDb(TEST_DB_PATH);
  await createAgent({
    id: agentId,
    name: "HTTP Memory Gating Agent",
    isLead: false,
    status: "idle",
  });
  const nowIso = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    [sourceTaskId, agentId, "HTTP memory recall gating task", nowIso, nowIso],
  );
  for (const memoryFixture of [memory, memoryChunk, thresholdMemory]) {
    await getDbClient().run(
      `INSERT INTO agent_memory
       (id, agentId, scope, key, name, content, source, chunkIndex, totalChunks, createdAt, accessedAt)
       VALUES (?, ?, 'agent', ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [
        memoryFixture.id,
        agentId,
        memoryFixture.key ?? null,
        memoryFixture.name,
        memoryFixture.content,
        memoryFixture.chunkIndex,
        memoryFixture.totalChunks,
        nowIso,
        nowIso,
      ],
    );
  }
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM memory_retrieval");
  await getDbClient().run("UPDATE agent_memory SET accessCount = 0 WHERE id IN (?, ?, ?)", [
    memoryId,
    memoryChunkId,
    thresholdMemoryId,
  ]);
});

afterAll(async () => {
  // bun's mock.module is process-global and never auto-restored — without
  // this, every later test file importing @/be/memory gets a getMemoryStore
  // stub with no edit() (broke memory-edit.test.ts on Linux CI, where the
  // readdir-driven file order runs this file first).
  mock.module("../be/memory", () => realMemoryExports);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("memory HTTP recall capture gating", () => {
  test("POST /api/memory/search accepts UI calls without intent and does not record retrievals", async () => {
    const response = await callMemoryRoute(
      "POST",
      "/api/memory/search",
      ["api", "memory", "search"],
      { query: "UI browse/search", limit: 5 },
      { "x-source-task-id": sourceTaskId, "x-context-key": "task:ui-browse" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0].id).toBe(memoryId);
    expect(await countRetrievals()).toBe(0);
    expect(
      await getDbClient().get<{ accessCount: number }>(
        "SELECT accessCount FROM agent_memory WHERE id = ?",
        [memoryId],
      ),
    ).toEqual({ accessCount: 0 });
  });

  test("POST /api/memory/search counts each logical document once", async () => {
    const response = await callMemoryRoute(
      "POST",
      "/api/memory/search",
      ["api", "memory", "search"],
      { query: "document recall", intent: "explicit agent recall", limit: 5 },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.results.map((result: any) => result.accessCount)).toEqual([1, 0]);
    expect(
      await getDbClient().query<{ id: string; accessCount: number }>(
        "SELECT id, accessCount FROM agent_memory WHERE id IN (?, ?) ORDER BY chunkIndex",
        [memoryId, memoryChunkId],
      ),
    ).toEqual([
      { id: memoryId, accessCount: 1 },
      { id: memoryChunkId, accessCount: 0 },
    ]);
  });

  test("prompt recall excludes memories at the injection threshold", async () => {
    const response = await callMemoryRoute(
      "POST",
      "/api/memory/search",
      ["api", "memory", "search"],
      { query: "prompt recall", intent: "pre-task memory recall", limit: 5 },
      { "x-memory-consumption": "prompt" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.results.map((result: any) => result.accessCount)).toEqual([1, 0]);
    expect(
      await getDbClient().get<{ accessCount: number }>(
        "SELECT accessCount FROM agent_memory WHERE id = ?",
        [thresholdMemoryId],
      ),
    ).toEqual({ accessCount: 0 });
  });

  test("GET /api/memory/:id accepts UI calls without intent and does not record retrievals", async () => {
    const response = await callMemoryRoute(
      "GET",
      `/api/memory/${memoryId}`,
      ["api", "memory", memoryId],
      undefined,
      { "x-source-task-id": sourceTaskId, "x-context-key": "task:ui-browse" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.memory.id).toBe(memoryId);
    expect(await countRetrievals()).toBe(0);
  });
});
