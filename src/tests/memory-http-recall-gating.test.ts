import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import type { AgentMemory } from "../types";

const memoryId = randomUUID();
const agentId = randomUUID();
const sourceTaskId = randomUUID();
const TEST_DB_PATH = "./test-memory-http-recall-gating.sqlite";

const memory: AgentMemory = {
  id: memoryId,
  agentId,
  content: "UI browse/search memory fixture",
  name: "ui-memory-fixture",
  scope: "agent",
  source: "manual",
  sourcePath: null,
  sourceTaskId: null,
  chunkIndex: 0,
  totalChunks: 1,
  tags: [],
  contextKey: null,
  createdAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
};

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test-embedding",
    dimensions: 3,
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
  }),
  getMemoryStore: () => ({
    store: (input: import("../be/memory/types").MemoryInput): import("../types").AgentMemory => {
      const { SqliteMemoryStore } =
        require("../be/memory/providers/sqlite-store") as typeof import("../be/memory/providers/sqlite-store");
      return new SqliteMemoryStore().store(input);
    },
    get: (id: string) => {
      if (id === memory.id) return memory;
      const { SqliteMemoryStore } =
        require("../be/memory/providers/sqlite-store") as typeof import("../be/memory/providers/sqlite-store");
      return new SqliteMemoryStore().get(id);
    },
    peek: (id: string) => {
      if (id === memory.id) return memory;
      const { SqliteMemoryStore } =
        require("../be/memory/providers/sqlite-store") as typeof import("../be/memory/providers/sqlite-store");
      return new SqliteMemoryStore().peek(id);
    },
    search: () => [
      {
        ...memory,
        similarity: 0.95,
        rawSimilarity: 0.95,
        compositeScore: 0.95,
        accessCount: 0,
        expiresAt: null,
        embeddingModel: "test-embedding",
        alpha: 1,
        beta: 1,
      },
    ],
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

function countRetrievals(): number {
  return getDb().prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_retrieval").get()!.n;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }

  initDb(TEST_DB_PATH);
  createAgent({ id: agentId, name: "HTTP Memory Gating Agent", isLead: false, status: "idle" });
  const nowIso = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    )
    .run(sourceTaskId, agentId, "HTTP memory recall gating task", nowIso, nowIso);
});

beforeEach(() => {
  getDb().run("DELETE FROM memory_retrieval");
});

afterAll(async () => {
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
    expect(countRetrievals()).toBe(0);
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
    expect(countRetrievals()).toBe(0);
  });
});
