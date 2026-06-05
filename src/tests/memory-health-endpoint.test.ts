import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { closeDb, initDb } from "../be/db";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import { handleMemory } from "../http/memory";
import { getPathSegments } from "../http/utils";

const TEST_DB_PATH = "./test-memory-health-endpoint.sqlite";

function fakeReqRes(path: string) {
  const req = {
    method: "GET",
    url: path,
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

  return { req, res, captured };
}

describe("GET /api/memory/health", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("returns vector index health JSON", async () => {
    const { req, res, captured } = fakeReqRes("/api/memory/health");
    const handled = await handleMemory(req, res, getPathSegments(req.url || ""), undefined);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);

    const body = JSON.parse(captured.body);
    expect(body).toMatchObject({
      sqliteVec: {
        extensionLoaded: expect.any(Boolean),
        tableExists: expect.any(Boolean),
        initialized: expect.any(Boolean),
        vectorDimensions: EMBEDDING_DIMENSIONS,
        distanceMetric: "cosine",
      },
      counts: {
        total: expect.any(Number),
        withEmbedding: expect.any(Number),
        searchable: expect.any(Number),
        memoryVec: expect.any(Number),
      },
      retrievalMode: expect.any(String),
      reasons: expect.any(Array),
    });
  });
});
