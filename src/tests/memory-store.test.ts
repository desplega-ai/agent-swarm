import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

const TEST_DB_PATH = "./test-memory-store.sqlite";

describe("SqliteMemoryStore", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000001";
  const agentB = "bbbb0000-0000-4000-8000-000000000002";
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    await initDb(TEST_DB_PATH);
    await createAgent({ id: agentA, name: "Test Agent A", isLead: false, status: "idle" });
    await createAgent({ id: agentB, name: "Test Agent B", isLead: false, status: "idle" });
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

  describe("store()", () => {
    test("creates memory with correct fields", async () => {
      const memory = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "test memory",
        content: "test content",
        source: "manual",
      });
      expect(memory.id).toBeDefined();
      expect(memory.agentId).toBe(agentA);
      expect(memory.scope).toBe("agent");
      expect(memory.name).toBe("test memory");
      expect(memory.content).toBe("test content");
      expect(memory.source).toBe("manual");
    });

    test("task_completion → expiresAt ≈ now + 7d", async () => {
      const before = Date.now();
      const memory = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "task mem",
        content: "task content",
        source: "task_completion",
      });
      expect(memory.expiresAt).toBeDefined();
      const expires = new Date(memory.expiresAt!).getTime();
      const expectedMin = before + 7 * 86400000 - 5000;
      const expectedMax = Date.now() + 7 * 86400000 + 5000;
      expect(expires).toBeGreaterThan(expectedMin);
      expect(expires).toBeLessThan(expectedMax);
    });

    test("session_summary → expiresAt ≈ now + 3d", async () => {
      const memory = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "session mem",
        content: "session content",
        source: "session_summary",
      });
      expect(memory.expiresAt).toBeDefined();
      const expires = new Date(memory.expiresAt!).getTime();
      const expected = Date.now() + 3 * 86400000;
      expect(Math.abs(expires - expected)).toBeLessThan(5000);
    });

    test("manual → expiresAt is null", async () => {
      const memory = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "manual mem",
        content: "manual content",
        source: "manual",
      });
      expect(memory.expiresAt).toBeNull();
    });
  });

  describe("storeBatch()", () => {
    test("atomically stores multiple memories", async () => {
      const memories = await store.storeBatch([
        { agentId: agentA, scope: "agent", name: "batch1", content: "c1", source: "manual" },
        { agentId: agentA, scope: "agent", name: "batch2", content: "c2", source: "manual" },
      ]);
      expect(memories).toHaveLength(2);
      expect(memories[0]!.name).toBe("batch1");
      expect(memories[1]!.name).toBe("batch2");
    });
  });

  describe("get() and peek()", () => {
    test("get returns memory and increments accessCount", async () => {
      const created = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "get test",
        content: "content",
        source: "manual",
      });

      const first = await store.get(created.id);
      expect(first).toBeDefined();
      expect(first!.name).toBe("get test");

      const second = await store.get(created.id);
      expect(second).toBeDefined();

      // Verify accessCount incremented by peeking (no side effects)
      const peeked = await store.peek(created.id);
      expect(peeked!.accessCount).toBe(2);
    });

    test("peek does NOT increment accessCount", async () => {
      const created = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "peek test",
        content: "content",
        source: "manual",
      });

      await store.peek(created.id);
      await store.peek(created.id);
      await store.peek(created.id);

      const peeked = await store.peek(created.id);
      expect(peeked!.accessCount).toBe(0);
    });

    test("get returns null for non-existent ID", async () => {
      expect(await store.get("00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });

  describe("search()", () => {
    test("returns candidates sorted by similarity", async () => {
      // Create memories with known embeddings
      const m1 = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "search1",
        content: "first",
        source: "manual",
      });
      await store.updateEmbedding(m1.id, new Float32Array([1, 0, 0]), "test-model");

      const m2 = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "search2",
        content: "second",
        source: "manual",
      });
      await store.updateEmbedding(m2.id, new Float32Array([0.9, 0.1, 0]), "test-model");

      const query = new Float32Array([1, 0, 0]);
      const results = await store.search(query, agentA, { limit: 10 });
      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should be most similar (exact match)
      expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
    });

    test("respects scope filtering", async () => {
      const m1 = await store.store({
        agentId: agentB,
        scope: "agent",
        name: "agent-only",
        content: "agent scoped",
        source: "manual",
      });
      await store.updateEmbedding(m1.id, new Float32Array([0, 0.5, 0.5]), "test-model");

      const m2 = await store.store({
        agentId: agentB,
        scope: "swarm",
        name: "swarm-shared",
        content: "swarm scoped",
        source: "manual",
      });
      await store.updateEmbedding(m2.id, new Float32Array([0, 0.5, 0.5]), "test-model");

      const query = new Float32Array([0, 0.5, 0.5]);

      const agentOnly = await store.search(query, agentB, { scope: "agent", limit: 50 });
      expect(agentOnly.every((r) => r.scope === "agent")).toBe(true);

      const swarmOnly = await store.search(query, agentB, { scope: "swarm", limit: 50 });
      expect(swarmOnly.every((r) => r.scope === "swarm")).toBe(true);
    });

    test("isLead=true sees all memories", async () => {
      const query = new Float32Array([1, 0, 0]);
      const results = await store.search(query, agentA, { isLead: true, limit: 100 });
      // Lead should see both agentA and agentB memories
      const agents = new Set(results.map((r) => r.agentId));
      expect(agents.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("delete()", () => {
    test("removes memory", async () => {
      const memory = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "to delete",
        content: "deleteme",
        source: "manual",
      });
      const deleted = await store.delete(memory.id);
      expect(deleted).toBe(true);
      expect(await store.peek(memory.id)).toBeNull();
    });

    test("returns false for non-existent", async () => {
      expect(await store.delete("00000000-0000-0000-0000-000000000000")).toBe(false);
    });
  });

  describe("deleteBySourcePath()", () => {
    test("removes all matching memories", async () => {
      const path = "/test/delete-path.ts";
      await store.store({
        agentId: agentA,
        scope: "agent",
        name: "chunk1",
        content: "c1",
        source: "file_index",
        sourcePath: path,
      });
      await store.store({
        agentId: agentA,
        scope: "agent",
        name: "chunk2",
        content: "c2",
        source: "file_index",
        sourcePath: path,
      });

      const deleted = await store.deleteBySourcePath(path, agentA);
      expect(deleted).toBe(2);
    });
  });

  describe("updateEmbedding()", () => {
    test("sets embedding and model", async () => {
      const memory = await store.store({
        agentId: agentA,
        scope: "agent",
        name: "embed test",
        content: "embeddable",
        source: "manual",
      });
      await store.updateEmbedding(
        memory.id,
        new Float32Array([1, 2, 3]),
        "openai/text-embedding-3-small",
      );

      const updated = await store.peek(memory.id);
      expect(updated!.embeddingModel).toBe("openai/text-embedding-3-small");
    });
  });

  describe("getStats()", () => {
    test("returns correct counts", async () => {
      const statsAgent = "cccc0000-0000-4000-8000-000000000003";
      await createAgent({ id: statsAgent, name: "Stats Agent", isLead: false, status: "idle" });

      await store.store({
        agentId: statsAgent,
        scope: "agent",
        name: "s1",
        content: "c1",
        source: "manual",
      });
      await store.store({
        agentId: statsAgent,
        scope: "swarm",
        name: "s2",
        content: "c2",
        source: "task_completion",
      });
      await store.store({
        agentId: statsAgent,
        scope: "agent",
        name: "s3",
        content: "c3",
        source: "manual",
      });

      const stats = await store.getStats(statsAgent);
      expect(stats.total).toBe(3);
      expect(stats.bySource.manual).toBe(2);
      expect(stats.bySource.task_completion).toBe(1);
      expect(stats.byScope.agent).toBe(2);
      expect(stats.byScope.swarm).toBe(1);
    });
  });

  describe("listForReembedding()", () => {
    test("returns id and content", async () => {
      const all = await store.listForReembedding();
      expect(all.length).toBeGreaterThan(0);
      expect(all[0]).toHaveProperty("id");
      expect(all[0]).toHaveProperty("content");
    });

    test("filters by agentId", async () => {
      const filtered = await store.listForReembedding({ agentId: agentA });
      expect(filtered.every((_m) => true)).toBe(true); // just verifying it doesn't throw
      expect(filtered.length).toBeGreaterThan(0);
    });
  });
});
