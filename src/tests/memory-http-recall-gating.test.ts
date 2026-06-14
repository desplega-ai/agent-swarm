import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AgentMemory } from "../types";

const memoryId = randomUUID();
const agentId = randomUUID();
const sourceTaskId = randomUUID();

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

const recordRetrievals = mock(() => {});

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test-embedding",
    dimensions: 3,
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
  }),
  getMemoryStore: () => ({
    get: () => memory,
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

mock.module("../be/memory/raters/retrieval", () => ({
  recordRetrievals,
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

describe("memory HTTP recall capture gating", () => {
  test("POST /api/memory/search accepts UI calls without intent and does not record retrievals", async () => {
    recordRetrievals.mockClear();

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
    expect(recordRetrievals).not.toHaveBeenCalled();
  });

  test("GET /api/memory/:id accepts UI calls without intent and does not record retrievals", async () => {
    recordRetrievals.mockClear();

    const response = await callMemoryRoute(
      "GET",
      `/api/memory/${memoryId}`,
      ["api", "memory", memoryId],
      undefined,
      { "x-source-task-id": sourceTaskId, "x-context-key": "task:ui-browse" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.memory.id).toBe(memoryId);
    expect(recordRetrievals).not.toHaveBeenCalled();
  });
});
