import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { computeRrfScore, SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

const TEST_DB_PATH = "./test-memory-hybrid.sqlite";
const agentId = "aaaa0000-0000-4000-8000-000000000101";

function vector(value: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[0] = value;
  return embedding;
}

describe("computeRrfScore", () => {
  test("rank 0 with no decay produces max reciprocal score", () => {
    const score = computeRrfScore(0, 1.0);
    expect(score).toBeCloseTo(1 / 61, 6);
  });

  test("higher rank produces lower score", () => {
    expect(computeRrfScore(0, 1.0)).toBeGreaterThan(computeRrfScore(5, 1.0));
    expect(computeRrfScore(5, 1.0)).toBeGreaterThan(computeRrfScore(50, 1.0));
  });

  test("decay factor scales the score linearly", () => {
    const full = computeRrfScore(3, 1.0);
    const half = computeRrfScore(3, 0.5);
    expect(half).toBeCloseTo(full * 0.5, 6);
  });

  test("custom k changes the smoothing constant", () => {
    const defaultK = computeRrfScore(0, 1.0, 60);
    const smallK = computeRrfScore(0, 1.0, 10);
    expect(smallK).toBeGreaterThan(defaultK);
    expect(smallK).toBeCloseTo(1 / 11, 6);
  });

  test("two arms sum to compound a memory that appears in both", () => {
    const vecScore = computeRrfScore(0, 1.0);
    const ftsScore = computeRrfScore(2, 1.0);
    const compound = vecScore + ftsScore;
    expect(compound).toBeGreaterThan(vecScore);
    expect(compound).toBeGreaterThan(ftsScore);
  });
});

describe("memory hybrid search", () => {
  let store: SqliteMemoryStore;
  let prevHybridFlag: string | undefined;

  beforeAll(async () => {
    prevHybridFlag = process.env.MEMORY_HYBRID_SEARCH;
    process.env.MEMORY_HYBRID_SEARCH = "1";
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentId, name: "Hybrid Test Agent", isLead: false, status: "idle" });
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    if (prevHybridFlag === undefined) delete process.env.MEMORY_HYBRID_SEARCH;
    else process.env.MEMORY_HYBRID_SEARCH = prevHybridFlag;
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("syncs FTS rows on store and delete", () => {
    const memory = store.store({
      agentId,
      scope: "agent",
      name: "lexical row",
      content: "contains frobnicate-token",
      source: "manual",
    });

    const inserted = getDb()
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE memory_id = ?",
      )
      .get(memory.id)?.count;
    expect(inserted).toBe(1);

    store.delete(memory.id);
    const deleted = getDb()
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE memory_id = ?",
      )
      .get(memory.id)?.count;
    expect(deleted).toBe(0);
  });

  test("uses keyword arm for exact terms and dedupes fused results", () => {
    const exact = store.store({
      agentId,
      scope: "agent",
      name: "runbook",
      content: "The incident codeword is quasarneedle.",
      source: "manual",
    });
    const semantic = store.store({
      agentId,
      scope: "agent",
      name: "general note",
      content: "A generic operational note.",
      source: "manual",
    });
    store.updateEmbedding(exact.id, vector(1), "test");
    store.updateEmbedding(semantic.id, vector(1), "test");

    const results = store.search(vector(1), agentId, {
      scope: "agent",
      limit: 10,
      queryText: "quasarneedle",
    });

    expect(results.some((result) => result.id === exact.id)).toBe(true);
    expect(new Set(results.map((result) => result.id)).size).toBe(results.length);
    expect(results.find((result) => result.id === exact.id)?.retrievalSource).toBe("hybrid");
    expect(results.find((result) => result.id === semantic.id)?.retrievalSource).toBe("vec");
  });

  test("hybrid RRF compounds memories present in both vector and FTS arms", () => {
    const both = store.store({
      agentId,
      scope: "agent",
      name: "compound exact",
      content: "The exact compound marker is rrfneedle.",
      source: "manual",
    });
    const vectorOnly = store.store({
      agentId,
      scope: "agent",
      name: "compound semantic",
      content: "A semantic-only note.",
      source: "manual",
    });
    store.updateEmbedding(both.id, vector(1), "test");
    store.updateEmbedding(vectorOnly.id, vector(1), "test");

    const results = store.search(vector(1), agentId, {
      scope: "agent",
      limit: 10,
      queryText: "rrfneedle",
    });

    const bothResult = results.find((result) => result.id === both.id);
    const vectorOnlyResult = results.find((result) => result.id === vectorOnly.id);
    expect(bothResult?.retrievalSource).toBe("hybrid");
    expect(vectorOnlyResult?.retrievalSource).toBe("vec");
    expect(bothResult!.similarity).toBeGreaterThan(vectorOnlyResult!.similarity);
  });

  test("falls back to keyword-only search when vector query is unavailable", () => {
    const exact = store.store({
      agentId,
      scope: "agent",
      name: "keyword fallback",
      content: "The fallback marker is lexiconneedle.",
      source: "manual",
    });

    const results = store.search(new Float32Array(0), agentId, {
      scope: "agent",
      limit: 5,
      queryText: "lexiconneedle",
    });

    expect(results.map((result) => result.id)).toContain(exact.id);
    expect(results.find((result) => result.id === exact.id)?.retrievalSource).toBe("fts");
  });

  test("applies source-aware recency decay to FTS-only ranking", () => {
    const stale = store.store({
      agentId,
      scope: "agent",
      name: "stale keyword",
      content: "The decay marker is decayneedle.",
      source: "task_completion",
    });
    const fresh = store.store({
      agentId,
      scope: "agent",
      name: "fresh keyword",
      content: "The decay marker is decayneedle.",
      source: "task_completion",
    });
    getDb()
      .prepare("UPDATE agent_memory SET createdAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 86400000).toISOString(), stale.id);

    const results = store.search(new Float32Array(0), agentId, {
      scope: "agent",
      limit: 10,
      queryText: "decayneedle",
    });

    const staleIndex = results.findIndex((result) => result.id === stale.id);
    const freshIndex = results.findIndex((result) => result.id === fresh.id);
    expect(freshIndex).toBeGreaterThanOrEqual(0);
    expect(staleIndex).toBeGreaterThanOrEqual(0);
    expect(freshIndex).toBeLessThan(staleIndex);
  });
});
