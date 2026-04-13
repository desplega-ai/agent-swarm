import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { rerank } from "../be/memory/reranker";

const TEST_DB_PATH = "./test-memory-e2e.sqlite";

describe("Memory E2E Lifecycle", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000e01";
  const agentB = "bbbb0000-0000-4000-8000-000000000e02";
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "E2E Agent A", isLead: false, status: "idle" });
    createAgent({ id: agentB, name: "E2E Agent B", isLead: true, status: "idle" });
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  // ==========================================================================
  // Full lifecycle: store → search → get → delete
  // ==========================================================================

  describe("store → search → get → delete lifecycle", () => {
    let memoryId: string;

    test("store creates a memory with correct fields", () => {
      const memory = store.store({
        agentId: agentA,
        scope: "agent",
        name: "deployment info",
        content: "The deployment pipeline uses GitHub Actions with staging on Fly.io",
        source: "manual",
        tags: ["deployment", "ci"],
      });
      memoryId = memory.id;
      expect(memory.id).toBeDefined();
      expect(memory.agentId).toBe(agentA);
      expect(memory.content).toContain("GitHub Actions");
    });

    test("updateEmbedding stores vector and model name", () => {
      const embedding = new Float32Array([0.8, 0.2, 0.1]);
      store.updateEmbedding(memoryId, embedding, "test-model-v1");

      // Verify via raw SQL
      const row = getDb()
        .prepare("SELECT embeddingModel FROM agent_memory WHERE id = ?")
        .get(memoryId) as { embeddingModel: string | null };
      expect(row.embeddingModel).toBe("test-model-v1");
    });

    test("search returns the memory with similarity score", () => {
      const query = new Float32Array([0.8, 0.2, 0.1]); // same as stored
      const results = store.search(query, agentA, { limit: 5 });
      expect(results.length).toBeGreaterThan(0);

      const found = results.find((r) => r.id === memoryId);
      expect(found).toBeDefined();
      expect(found!.similarity).toBeCloseTo(1.0, 3);
    });

    test("get retrieves memory and increments accessCount", () => {
      const mem1 = store.get(memoryId);
      expect(mem1).not.toBeNull();
      expect(mem1!.name).toBe("deployment info");

      // Access count should increment on each get
      const row1 = getDb()
        .prepare("SELECT accessCount FROM agent_memory WHERE id = ?")
        .get(memoryId) as { accessCount: number };
      const count1 = row1.accessCount;

      store.get(memoryId);
      const row2 = getDb()
        .prepare("SELECT accessCount FROM agent_memory WHERE id = ?")
        .get(memoryId) as { accessCount: number };
      expect(row2.accessCount).toBe(count1 + 1);
    });

    test("peek reads without incrementing accessCount", () => {
      const rowBefore = getDb()
        .prepare("SELECT accessCount FROM agent_memory WHERE id = ?")
        .get(memoryId) as { accessCount: number };

      const mem = store.peek(memoryId);
      expect(mem).not.toBeNull();
      expect(mem!.name).toBe("deployment info");

      const rowAfter = getDb()
        .prepare("SELECT accessCount FROM agent_memory WHERE id = ?")
        .get(memoryId) as { accessCount: number };
      expect(rowAfter.accessCount).toBe(rowBefore.accessCount);
    });

    test("delete removes the memory", () => {
      const deleted = store.delete(memoryId);
      expect(deleted).toBe(true);

      const found = store.get(memoryId);
      expect(found).toBeNull();
    });
  });

  // ==========================================================================
  // Reranking: newer memories rank higher with similar embeddings
  // ==========================================================================

  describe("reranking affects result order", () => {
    test("newer memory with same embedding ranks higher", () => {
      // Create old memory
      const old = store.store({
        agentId: agentA,
        scope: "agent",
        name: "old knowledge",
        content: "Old deployment docs",
        source: "manual",
      });
      store.updateEmbedding(old.id, new Float32Array([0.5, 0.5, 0.0]), "test-model");

      // Backdate the old memory's createdAt
      getDb()
        .prepare("UPDATE agent_memory SET createdAt = datetime('now', '-30 days') WHERE id = ?")
        .run(old.id);

      // Create fresh memory with similar embedding
      const fresh = store.store({
        agentId: agentA,
        scope: "agent",
        name: "fresh knowledge",
        content: "New deployment docs",
        source: "manual",
      });
      store.updateEmbedding(fresh.id, new Float32Array([0.5, 0.5, 0.0]), "test-model");

      // Search with matching query
      const candidates = store.search(new Float32Array([0.5, 0.5, 0.0]), agentA, {
        limit: 20,
      });
      const ranked = rerank(candidates, { limit: 10 });

      const freshIdx = ranked.findIndex((r) => r.id === fresh.id);
      const oldIdx = ranked.findIndex((r) => r.id === old.id);

      expect(freshIdx).toBeGreaterThanOrEqual(0);
      expect(oldIdx).toBeGreaterThanOrEqual(0);
      expect(freshIdx).toBeLessThan(oldIdx); // fresh ranks higher

      // Cleanup
      store.delete(old.id);
      store.delete(fresh.id);
    });
  });

  // ==========================================================================
  // TTL expiry filtering
  // ==========================================================================

  describe("TTL expiry filtering", () => {
    test("task_completion has ~7d TTL", () => {
      const memory = store.store({
        agentId: agentA,
        scope: "agent",
        name: "task result",
        content: "Completed task output",
        source: "task_completion",
      });

      const row = getDb()
        .prepare("SELECT expiresAt FROM agent_memory WHERE id = ?")
        .get(memory.id) as { expiresAt: string | null };
      expect(row.expiresAt).not.toBeNull();

      const expiresAt = new Date(row.expiresAt!).getTime();
      const expectedMin = Date.now() + 6 * 24 * 60 * 60 * 1000; // ~6d
      const expectedMax = Date.now() + 8 * 24 * 60 * 60 * 1000; // ~8d
      expect(expiresAt).toBeGreaterThan(expectedMin);
      expect(expiresAt).toBeLessThan(expectedMax);

      store.delete(memory.id);
    });

    test("manual source has no TTL (null expiresAt)", () => {
      const memory = store.store({
        agentId: agentA,
        scope: "agent",
        name: "permanent note",
        content: "This should never expire",
        source: "manual",
      });

      const row = getDb()
        .prepare("SELECT expiresAt FROM agent_memory WHERE id = ?")
        .get(memory.id) as { expiresAt: string | null };
      expect(row.expiresAt).toBeNull();

      store.delete(memory.id);
    });

    test("expired memories are excluded from search", () => {
      const memory = store.store({
        agentId: agentA,
        scope: "agent",
        name: "expired item",
        content: "This should be hidden from search",
        source: "session_summary",
      });
      store.updateEmbedding(memory.id, new Float32Array([0.9, 0.1, 0.0]), "test-model");

      // Force expiry by backdating expiresAt
      getDb()
        .prepare("UPDATE agent_memory SET expiresAt = datetime('now', '-1 day') WHERE id = ?")
        .run(memory.id);

      // Search should NOT return expired memory
      const results = store.search(new Float32Array([0.9, 0.1, 0.0]), agentA, { limit: 20 });
      const found = results.find((r) => r.id === memory.id);
      expect(found).toBeUndefined();

      // But get() still returns it (lazy expiry — no hard delete)
      const direct = store.get(memory.id);
      expect(direct).not.toBeNull();
      expect(direct!.name).toBe("expired item");

      // includeExpired: true should return it in search
      const withExpired = store.search(new Float32Array([0.9, 0.1, 0.0]), agentA, {
        limit: 20,
        includeExpired: true,
      });
      const foundExpired = withExpired.find((r) => r.id === memory.id);
      expect(foundExpired).toBeDefined();

      store.delete(memory.id);
    });
  });

  // ==========================================================================
  // Batch operations
  // ==========================================================================

  describe("storeBatch atomicity", () => {
    test("stores multiple chunks atomically", () => {
      const chunks = [
        { content: "Chunk 0 content", chunkIndex: 0, totalChunks: 3 },
        { content: "Chunk 1 content", chunkIndex: 1, totalChunks: 3 },
        { content: "Chunk 2 content", chunkIndex: 2, totalChunks: 3 },
      ];

      const memories = store.storeBatch(
        chunks.map((c) => ({
          agentId: agentA,
          scope: "agent" as const,
          name: "batch-test",
          content: c.content,
          source: "file_index" as const,
          sourcePath: "/test/batch.md",
          chunkIndex: c.chunkIndex,
          totalChunks: c.totalChunks,
        })),
      );

      expect(memories.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(memories[i].chunkIndex).toBe(i);
        expect(memories[i].totalChunks).toBe(3);
      }

      // Cleanup
      store.deleteBySourcePath("/test/batch.md", agentA);
    });
  });

  // ==========================================================================
  // Scope visibility
  // ==========================================================================

  describe("scope visibility rules", () => {
    let agentMemId: string;
    let swarmMemId: string;
    let otherAgentMemId: string;

    beforeAll(() => {
      const m1 = store.store({
        agentId: agentA,
        scope: "agent",
        name: "A's private",
        content: "Agent A only",
        source: "manual",
      });
      store.updateEmbedding(m1.id, new Float32Array([1, 0, 0]), "test-model");
      agentMemId = m1.id;

      const m2 = store.store({
        agentId: agentA,
        scope: "swarm",
        name: "shared knowledge",
        content: "Visible to all",
        source: "manual",
      });
      store.updateEmbedding(m2.id, new Float32Array([0, 1, 0]), "test-model");
      swarmMemId = m2.id;

      const m3 = store.store({
        agentId: agentB,
        scope: "agent",
        name: "B's private",
        content: "Agent B only",
        source: "manual",
      });
      store.updateEmbedding(m3.id, new Float32Array([0, 0, 1]), "test-model");
      otherAgentMemId = m3.id;
    });

    afterAll(() => {
      store.delete(agentMemId);
      store.delete(swarmMemId);
      store.delete(otherAgentMemId);
    });

    test("worker sees own agent-scoped + swarm memories", () => {
      const results = store.search(new Float32Array([1, 1, 1]), agentA, { isLead: false });
      const names = results.map((r) => r.name);
      expect(names).toContain("A's private");
      expect(names).toContain("shared knowledge");
      expect(names).not.toContain("B's private");
    });

    test("lead sees all memories", () => {
      const results = store.search(new Float32Array([1, 1, 1]), agentA, { isLead: true });
      const names = results.map((r) => r.name);
      expect(names).toContain("A's private");
      expect(names).toContain("shared knowledge");
      expect(names).toContain("B's private");
    });
  });

  // ==========================================================================
  // Stats including expired count
  // ==========================================================================

  describe("getStats includes expired count", () => {
    test("reports expired memories", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "stats-expired",
        content: "Will expire",
        source: "session_summary",
      });

      // Force expiry
      getDb()
        .prepare("UPDATE agent_memory SET expiresAt = datetime('now', '-1 hour') WHERE id = ?")
        .run(mem.id);

      const stats = store.getStats(agentA);
      expect(stats.expired).toBeGreaterThanOrEqual(1);

      store.delete(mem.id);
    });
  });

  // ==========================================================================
  // Re-embed updates embeddingModel
  // ==========================================================================

  describe("updateEmbedding tracks model", () => {
    test("re-embedding updates embeddingModel column", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "model-track",
        content: "Track model changes",
        source: "manual",
      });

      // First embed
      store.updateEmbedding(mem.id, new Float32Array([0.1, 0.2, 0.3]), "model-v1");
      let row = getDb()
        .prepare("SELECT embeddingModel FROM agent_memory WHERE id = ?")
        .get(mem.id) as { embeddingModel: string | null };
      expect(row.embeddingModel).toBe("model-v1");

      // Re-embed with new model
      store.updateEmbedding(mem.id, new Float32Array([0.3, 0.2, 0.1]), "model-v2");
      row = getDb().prepare("SELECT embeddingModel FROM agent_memory WHERE id = ?").get(mem.id) as {
        embeddingModel: string | null;
      };
      expect(row.embeddingModel).toBe("model-v2");

      store.delete(mem.id);
    });
  });

  // ==========================================================================
  // listForReembedding
  // ==========================================================================

  describe("listForReembedding", () => {
    test("returns id and content for all memories", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "reembed-list",
        content: "Content for re-embedding",
        source: "manual",
      });

      const list = store.listForReembedding();
      expect(list.length).toBeGreaterThan(0);

      const found = list.find((item) => item.id === mem.id);
      expect(found).toBeDefined();
      expect(found!.content).toBe("Content for re-embedding");

      store.delete(mem.id);
    });

    test("filters by agentId", () => {
      const mem = store.store({
        agentId: agentB,
        scope: "agent",
        name: "reembed-filtered",
        content: "B's content",
        source: "manual",
      });

      const listAll = store.listForReembedding();
      const listB = store.listForReembedding({ agentId: agentB });
      expect(listB.length).toBeLessThanOrEqual(listAll.length);

      const found = listB.find((item) => item.id === mem.id);
      expect(found).toBeDefined();

      store.delete(mem.id);
    });
  });
});
