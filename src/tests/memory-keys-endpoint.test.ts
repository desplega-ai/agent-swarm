/**
 * GET /api/memory/keys, GET /api/memory/chunks and the key/updatedAt/rating
 * fields on POST /api/memory/list — the dashboard memory browser's reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { checkChunkIntegrity } from "../be/memory/key-browser";
import { handleMemory } from "../http/memory";
import { getPathSegments } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-memory-keys-endpoint.sqlite";

const AGENT_A = "aaaa0000-0000-4000-8000-00000000ke01";
const AGENT_B = "aaaa0000-0000-4000-8000-00000000ke02";

const LITMUS_KEY = "/longterm/facts/agenticos/litmus-check-allowlists";
const SIGTERM_KEY = "/longterm/facts/swarm-deploy/worker-sigterm-handoff-vs-api-drain";
const PERSON_KEY = "/longterm/entities/people/taras";

const IDS = {
  litmus0: "11110000-0000-4000-8000-000000000001",
  litmus1: "11110000-0000-4000-8000-000000000002",
  sigterm0: "11110000-0000-4000-8000-000000000003",
  sigterm1: "11110000-0000-4000-8000-000000000004",
  personA: "11110000-0000-4000-8000-000000000005",
  personB: "11110000-0000-4000-8000-000000000006",
  outside: "11110000-0000-4000-8000-000000000007",
  unkeyed: "11110000-0000-4000-8000-000000000008",
};

async function insertMemory(row: {
  id: string;
  key: string | null;
  name: string;
  content: string;
  scope?: "agent" | "swarm";
  agentId?: string | null;
  chunkIndex?: number;
  totalChunks?: number;
  accessCount?: number;
  alpha?: number;
  beta?: number;
  createdAt?: string;
  updatedAt?: string | null;
}) {
  const created = row.createdAt ?? "2026-10-01T00:00:00.000Z";
  await getDbClient().run(
    `INSERT INTO agent_memory (id, agentId, scope, key, name, content, source, chunkIndex,
       totalChunks, tags, createdAt, updatedAt, accessedAt, accessCount, alpha, beta)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.agentId ?? null,
      row.scope ?? "swarm",
      row.key,
      row.name,
      row.content,
      row.chunkIndex ?? 0,
      row.totalChunks ?? 1,
      created,
      row.updatedAt ?? null,
      created,
      row.accessCount ?? 0,
      row.alpha ?? 1,
      row.beta ?? 1,
    ],
  );
}

function fakeReqRes(method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as Readable &
    Partial<IncomingMessage>;
  req.method = method;
  req.url = path;
  req.headers = body === undefined ? {} : { "content-type": "application/json" };
  setRequestAuth(req as IncomingMessage, { kind: "operator", fingerprint: "memory-keys-test" });

  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = chunk;
      return this;
    },
  } as unknown as ServerResponse;
  return { req: req as IncomingMessage, res, captured };
}

async function call(method: string, path: string, body?: unknown, agentId?: string) {
  const { req, res, captured } = fakeReqRes(method, path, body);
  const handled = await handleMemory(req, res, getPathSegments(path), agentId);
  expect(handled).toBe(true);
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : null };
}

describe("memory browser endpoints", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    for (const id of [AGENT_A, AGENT_B]) {
      await createAgent({ id, name: `keys-${id.slice(-4)}`, isLead: false, status: "idle" });
    }

    // Complete 2-chunk memory; names differ across chunks, as in production.
    await insertMemory({
      id: IDS.litmus1,
      key: LITMUS_KEY,
      name: "litmus allowlists (part 2)",
      content: "B".repeat(10),
      chunkIndex: 1,
      totalChunks: 2,
      accessCount: 2,
      alpha: 1,
      beta: 2,
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    await insertMemory({
      id: IDS.litmus0,
      key: LITMUS_KEY,
      name: "litmus allowlists",
      content: "A".repeat(7),
      chunkIndex: 0,
      totalChunks: 2,
      accessCount: 3,
      alpha: 3,
      beta: 1,
    });
    // Stale chunk 0 says 1 chunk; orphan chunk 1 says 2.
    await insertMemory({
      id: IDS.sigterm0,
      key: SIGTERM_KEY,
      name: "sigterm handoff",
      content: "new single chunk",
      chunkIndex: 0,
      totalChunks: 1,
    });
    await insertMemory({
      id: IDS.sigterm1,
      key: SIGTERM_KEY,
      name: "sigterm handoff (old tail)",
      content: "orphan tail",
      chunkIndex: 1,
      totalChunks: 2,
    });
    // Same key, agent scope, two owners: two documents.
    await insertMemory({
      id: IDS.personA,
      key: PERSON_KEY,
      name: "person A",
      content: "a",
      scope: "agent",
      agentId: AGENT_A,
    });
    await insertMemory({
      id: IDS.personB,
      key: PERSON_KEY,
      name: "person B",
      content: "b",
      scope: "agent",
      agentId: AGENT_B,
    });
    await insertMemory({ id: IDS.outside, key: "/notes/x", name: "outside", content: "x" });
    await insertMemory({ id: IDS.unkeyed, key: null, name: "unkeyed", content: "plain" });

    await getDbClient().run(
      `INSERT INTO memory_rating (id, memoryId, taskId, source, signal, weight, reasoning, createdAt)
       VALUES (?, ?, NULL, 'llm', 1, 0.5, NULL, ?), (?, ?, NULL, 'llm', -1, 0.5, NULL, ?)`,
      [
        crypto.randomUUID(),
        IDS.litmus0,
        "2026-10-02T00:00:00.000Z",
        crypto.randomUUID(),
        IDS.litmus1,
        "2026-10-02T00:00:00.000Z",
      ],
    );
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  describe("GET /api/memory/keys", () => {
    test("groups chunk rows into one row per document under /longterm/ by default", async () => {
      const { status, body } = await call("GET", "/api/memory/keys");
      expect(status).toBe(200);
      expect(body.prefix).toBe("/longterm/");
      expect(body.truncated).toBe(false);
      const keys = body.keys.map((k: { key: string; agentId: string | null }) => k.key);
      expect(keys).toEqual([PERSON_KEY, PERSON_KEY, LITMUS_KEY, SIGTERM_KEY]);
    });

    test("aggregates usage, tokens, rating and dates over chunks", async () => {
      const { body } = await call("GET", "/api/memory/keys");
      const litmus = body.keys.find((k: { key: string }) => k.key === LITMUS_KEY);
      expect(litmus).toMatchObject({
        memoryId: IDS.litmus0,
        name: "litmus allowlists",
        scope: "swarm",
        agentId: null,
        chunkRows: 2,
        totalChunks: 2,
        complete: true,
        chars: 17,
        estTokens: 5,
        accessCount: 5,
        alpha: 4,
        beta: 3,
        usefulRatings: 1,
        notUsefulRatings: 1,
        updatedAt: "2026-10-03T00:00:00.000Z",
      });
      expect(litmus.rating).toBeCloseTo(4 / 7, 6);
    });

    test("flags an orphan chunk as incomplete", async () => {
      const { body } = await call("GET", "/api/memory/keys");
      const sigterm = body.keys.find((k: { key: string }) => k.key === SIGTERM_KEY);
      expect(sigterm).toMatchObject({ chunkRows: 2, totalChunks: 2, complete: false });
    });

    test("keeps agent-scope documents from different owners apart", async () => {
      const { body } = await call("GET", "/api/memory/keys?prefix=/longterm/entities/");
      expect(body.keys.map((k: { agentId: string }) => k.agentId).sort()).toEqual(
        [AGENT_A, AGENT_B].sort(),
      );
    });

    test("prefix is literal and limit truncates", async () => {
      const none = await call("GET", "/api/memory/keys?prefix=/longterm/%25");
      expect(none.body.keys).toEqual([]);
      const one = await call("GET", "/api/memory/keys?limit=1");
      expect(one.body.keys).toHaveLength(1);
      expect(one.body.truncated).toBe(true);
    });
  });

  describe("GET /api/memory/chunks", () => {
    test("returns every chunk of a complete memory in chunkIndex order", async () => {
      const { status, body } = await call("GET", `/api/memory/chunks?memoryId=${IDS.litmus1}`);
      expect(status).toBe(200);
      expect(body.key).toBe(LITMUS_KEY);
      expect(body.chunks.map((c: { id: string }) => c.id)).toEqual([IDS.litmus0, IDS.litmus1]);
      expect(body.estTokens).toBe(5);
      expect(body.integrity.ok).toBe(true);
      expect(body.integrity.issues).toEqual([]);
    });

    test("reports conflicting chunk counts for the orphan chunk", async () => {
      const { body } = await call(
        "GET",
        `/api/memory/chunks?key=${encodeURIComponent(SIGTERM_KEY)}&scope=swarm&agentId=`,
      );
      expect(body.chunks.map((c: { id: string }) => c.id)).toEqual([IDS.sigterm0, IDS.sigterm1]);
      expect(body.integrity).toMatchObject({
        ok: false,
        expectedChunks: 2,
        conflictingTotals: [1, 2],
        missingIndexes: [],
        duplicateIndexes: [],
      });
      expect(body.integrity.issues[0]).toContain("disagree");
    });

    test("scopes a key lookup to its owner", async () => {
      const { body } = await call(
        "GET",
        `/api/memory/chunks?key=${encodeURIComponent(PERSON_KEY)}&scope=agent&agentId=${AGENT_B}`,
      );
      expect(body.chunks.map((c: { id: string }) => c.id)).toEqual([IDS.personB]);
    });

    test("an unkeyed memory is its own document", async () => {
      const { body } = await call("GET", `/api/memory/chunks?memoryId=${IDS.unkeyed}`);
      expect(body.key).toBeNull();
      expect(body.chunks).toHaveLength(1);
      expect(body.integrity.ok).toBe(true);
    });

    test("does not count as an access", async () => {
      await call("GET", `/api/memory/chunks?memoryId=${IDS.litmus0}`);
      const row = await getDbClient().get<{ accessCount: number }>(
        "SELECT accessCount FROM agent_memory WHERE id = ?",
        [IDS.litmus0],
      );
      expect(row?.accessCount).toBe(3);
    });

    test("404 for an unknown memory, 400 without memoryId or key", async () => {
      const missing = await call(
        "GET",
        "/api/memory/chunks?memoryId=99990000-0000-4000-8000-000000000000",
      );
      expect(missing.status).toBe(404);
      const bad = await call("GET", "/api/memory/chunks");
      expect(bad.status).toBe(400);
    });
  });

  describe("agent viewer", () => {
    test("keys show only the agent's own rows plus swarm-scope rows", async () => {
      const { body } = await call("GET", "/api/memory/keys", undefined, AGENT_A);
      const docs = body.keys.map((k: { key: string; agentId: string | null }) => [
        k.key,
        k.agentId,
      ]);
      expect(docs).toEqual([
        [PERSON_KEY, AGENT_A],
        [LITMUS_KEY, null],
        [SIGTERM_KEY, null],
      ]);
    });

    test("another agent's agent-scope chunks read as not found", async () => {
      const hidden = await call(
        "GET",
        `/api/memory/chunks?memoryId=${IDS.personB}`,
        undefined,
        AGENT_A,
      );
      expect(hidden.status).toBe(404);
      const own = await call(
        "GET",
        `/api/memory/chunks?memoryId=${IDS.personA}`,
        undefined,
        AGENT_A,
      );
      expect(own.status).toBe(200);
      const swarm = await call(
        "GET",
        `/api/memory/chunks?memoryId=${IDS.litmus0}`,
        undefined,
        AGENT_A,
      );
      expect(swarm.status).toBe(200);
    });

    test("a key-only lookup never returns another owner's rows", async () => {
      const path = `/api/memory/chunks?key=${encodeURIComponent(PERSON_KEY)}`;
      const asB = await call("GET", path, undefined, AGENT_B);
      expect(asB.status).toBe(200);
      expect(asB.body.chunks.map((c: { id: string }) => c.id)).toEqual([IDS.personB]);
      const asA = await call("GET", path, undefined, AGENT_A);
      expect(asA.body.chunks.map((c: { id: string }) => c.id)).toEqual([IDS.personA]);
    });

    test("an operator key-only lookup returns one document, not every owner's rows", async () => {
      const { body } = await call(
        "GET",
        `/api/memory/chunks?key=${encodeURIComponent(PERSON_KEY)}`,
      );
      expect(body.chunks).toHaveLength(1);
      expect(body.chunks[0].agentId).toBe(body.agentId);
    });
  });

  describe("POST /api/memory/list", () => {
    test("includes key, updatedAt and rating", async () => {
      const { status, body } = await call("POST", "/api/memory/list", { limit: 100 });
      expect(status).toBe(200);
      const litmus1 = body.results.find((r: { id: string }) => r.id === IDS.litmus1);
      expect(litmus1).toMatchObject({ key: LITMUS_KEY, updatedAt: "2026-10-03T00:00:00.000Z" });
      expect(litmus1.rating).toBeCloseTo(1 / 3, 6);
      const unkeyed = body.results.find((r: { id: string }) => r.id === IDS.unkeyed);
      expect(unkeyed).toMatchObject({ key: null, updatedAt: null, rating: 0.5 });
    });
  });
});

describe("checkChunkIntegrity", () => {
  test("missing, duplicate and out-of-range chunks", () => {
    const result = checkChunkIntegrity([
      { id: "a", chunkIndex: 0, totalChunks: 3 },
      { id: "b", chunkIndex: 0, totalChunks: 3 },
      { id: "c", chunkIndex: 3, totalChunks: 3 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.missingIndexes).toEqual([1, 2]);
    expect(result.duplicateIndexes).toEqual([0]);
    expect(result.outOfRangeIds).toEqual(["c"]);
    expect(result.issues).toHaveLength(3);
  });

  test("a single complete row is fine", () => {
    expect(checkChunkIntegrity([{ id: "a", chunkIndex: 0, totalChunks: 1 }]).ok).toBe(true);
  });
});
