import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import * as realMemoryModule from "../be/memory";
import { buildRecallQuery } from "../memory/recall-query";
import { getTemplateDefinition } from "../prompts/registry";
import "../tools/templates";
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

let embeddedQuery = "";
let searchedQuery = "";

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test-embedding",
    dimensions: 3,
    embed: async (query: string) => {
      embeddedQuery = query;
      return new Float32Array([1, 0, 0]);
    },
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
      searchedQuery = options.queryText ?? "";
      if (options.queryText === "document recall") {
        return [candidate(memory, 0.95), candidate(memoryChunk, 0.9)];
      }
      if (options.queryText === "prompt recall") {
        return [
          candidate(memory, 0.95),
          // Relevance exactly at the threshold; the manual-source boost lifts
          // the composite well above it. The gate must read relevance.
          candidate(thresholdMemory, SIMILARITY_THRESHOLD),
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

  test("prompt recall gates on relevance, not the boosted composite score", async () => {
    const response = await callMemoryRoute(
      "POST",
      "/api/memory/search",
      ["api", "memory", "search"],
      { query: "prompt recall", intent: "pre-task memory recall", limit: 5 },
      { "x-memory-consumption": "prompt", "x-source-task-id": sourceTaskId },
    );

    expect(response.statusCode).toBe(200);
    const threshold = response.body.results.find((r: any) => r.id === thresholdMemoryId);
    expect(threshold.similarity).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(threshold.rawSimilarity).toBe(SIMILARITY_THRESHOLD);
    expect(
      await getDbClient().get<{ similarity: number; relevance: number }>(
        "SELECT similarity, relevance FROM memory_retrieval WHERE memoryId = ?",
        [thresholdMemoryId],
      ),
    ).toEqual({ similarity: threshold.similarity, relevance: SIMILARITY_THRESHOLD });
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

function workerWrapper(event: "completed" | "failed", task = "", output = ""): string {
  return getTemplateDefinition(`task.worker.${event}`)!.defaultBody.replace(
    /{{(\w+)}}/g,
    (_, key) =>
      ({ task_desc: task, output_summary: output, failure_reason: output })[key as "task_desc"] ??
      "",
  );
}

describe("pre-task recall query", () => {
  for (const event of ["completed", "failed"] as const) {
    test(`${event} wrapper retains only task and output`, () => {
      expect(buildRecallQuery(workerWrapper(event, "Fix memory recall", "Fixed the query"))).toBe(
        "Fix memory recall\n\nFixed the query",
      );
      expect(buildRecallQuery(workerWrapper(event))).toBe("");
    });
  }

  test("preserves output headings and embedded thread context once", () => {
    const output =
      "Result\n\nIMPORTANT: actual output heading\n<thread_context>Context</thread_context>";
    expect(buildRecallQuery(workerWrapper("completed", "Task", output))).toBe(`Task\n\n${output}`);
    expect(
      buildRecallQuery(
        workerWrapper(
          "failed",
          "Task",
          "Reason\n\nDecide whether to reassign, retry, or handle the failure. Actual result",
        ),
      ),
    ).toContain("Actual result");
  });

  test("creator instructions do not become recall content", () => {
    for (const event of ["completed", "failed"] as const) {
      const wrapper = workerWrapper(event).replace(
        event === "completed" ? "Output:\n" : "Failure reason: ",
        `${event === "completed" ? "Output:\n" : "Failure reason: "}\nAdditional instructions from the task creator:\nReview quickly\n`,
      );
      expect(buildRecallQuery(wrapper)).toBe("");
    }
  });

  test("removes sibling context and preserves thread context", () => {
    const thread = "<thread_context>Earlier user intent</thread_context>";
    const query = `<sibling_tasks_in_progress>Unrelated task</sibling_tasks_in_progress>\n\n${workerWrapper("completed", "Fix recall", "Done")}\n\n${thread}`;
    expect(buildRecallQuery(query)).toBe(`Fix recall\n\nDone\n\n${thread}`);
    expect(buildRecallQuery(`User request\n${thread}`)).toBe(`User request\n${thread}`);
    expect(buildRecallQuery("Worker task completed — partial text")).toBe(
      "Worker task completed — partial text",
    );
  });

  test("bounds long ASCII and multilingual queries without splitting code points", () => {
    expect(buildRecallQuery("a".repeat(40000))).toBe("a".repeat(8191));
    const query = buildRecallQuery("你好🙂مرحبا".repeat(10000));
    expect(Buffer.byteLength(query)).toBeLessThanOrEqual(8191);
    expect(query).not.toContain("�");
    expect(Buffer.from(query).toString("utf8")).toBe(query);
  });

  test("HTTP prompt recall uses content for embedding and text search only", async () => {
    const original = workerWrapper("completed", "Fix recall", "Done");
    await callMemoryRoute(
      "POST",
      "/api/memory/search",
      ["api", "memory", "search"],
      { query: original },
      { "x-memory-consumption": "prompt" },
    );
    expect(embeddedQuery).toBe("Fix recall\n\nDone");
    expect(searchedQuery).toBe(embeddedQuery);
    await callMemoryRoute("POST", "/api/memory/search", ["api", "memory", "search"], {
      query: original,
    });
    expect(embeddedQuery).toBe(original);
    expect(searchedQuery).toBe(original);
  });

  test("blank wrapper skips search and retrieval records", async () => {
    embeddedQuery = "untouched";
    searchedQuery = "untouched";
    const before = await countRetrievals();
    const response = await callMemoryRoute(
      "POST",
      "/api/memory/search",
      ["api", "memory", "search"],
      { query: workerWrapper("completed"), intent: "pre-task memory recall" },
      { "x-memory-consumption": "prompt", "x-source-task-id": sourceTaskId },
    );
    expect(response.body.results).toEqual([]);
    expect(embeddedQuery).toBe("untouched");
    expect(searchedQuery).toBe("untouched");
    expect(await countRetrievals()).toBe(before);
  });
});
