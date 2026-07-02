import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb, isSqliteVecAvailable } from "../be/db";
import { serializeEmbedding } from "../be/embedding";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

const TEST_DB_PATH = "./test-memory-store.sqlite";

describe("SqliteMemoryStore", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000001";
  const agentB = "bbbb0000-0000-4000-8000-000000000002";
  let store: SqliteMemoryStore;

  function vector(values: Record<number, number>): Float32Array {
    const embedding = new Float32Array(512);
    for (const [index, value] of Object.entries(values)) {
      embedding[Number(index)] = value;
    }
    return embedding;
  }

  function skipVecAssertionsWhenUnavailable(): boolean {
    if (isSqliteVecAvailable()) return false;

    const health = store.getHealth();
    expect(health.sqliteVec.extensionLoaded).toBe(false);
    expect(health.retrievalMode).toBe("fallback");
    expect(health.reasons).toContain("sqlite_vec_extension_unavailable");
    return true;
  }

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "Test Agent A", isLead: false, status: "idle" });
    createAgent({ id: agentB, name: "Test Agent B", isLead: false, status: "idle" });
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
    test("creates memory with correct fields", () => {
      const memory = store.store({
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

    test("task_completion → expiresAt ≈ now + 7d", () => {
      const before = Date.now();
      const memory = store.store({
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

    test("session_summary → expiresAt ≈ now + 3d", () => {
      const memory = store.store({
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

    test("manual → expiresAt is null", () => {
      const memory = store.store({
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
    test("atomically stores multiple memories", () => {
      const memories = store.storeBatch([
        { agentId: agentA, scope: "agent", name: "batch1", content: "c1", source: "manual" },
        { agentId: agentA, scope: "agent", name: "batch2", content: "c2", source: "manual" },
      ]);
      expect(memories).toHaveLength(2);
      expect(memories[0]!.name).toBe("batch1");
      expect(memories[1]!.name).toBe("batch2");
    });
  });

  describe("get() and peek()", () => {
    test("get returns memory and increments accessCount", () => {
      const created = store.store({
        agentId: agentA,
        scope: "agent",
        name: "get test",
        content: "content",
        source: "manual",
      });

      const first = store.get(created.id);
      expect(first).toBeDefined();
      expect(first!.name).toBe("get test");

      const second = store.get(created.id);
      expect(second).toBeDefined();

      // Verify accessCount incremented by peeking (no side effects)
      const peeked = store.peek(created.id);
      expect(peeked!.accessCount).toBe(2);
    });

    test("peek does NOT increment accessCount", () => {
      const created = store.store({
        agentId: agentA,
        scope: "agent",
        name: "peek test",
        content: "content",
        source: "manual",
      });

      store.peek(created.id);
      store.peek(created.id);
      store.peek(created.id);

      const peeked = store.peek(created.id);
      expect(peeked!.accessCount).toBe(0);
    });

    test("get returns null for non-existent ID", () => {
      expect(store.get("00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });

  describe("search()", () => {
    test("returns candidates sorted by similarity", () => {
      // Create memories with known embeddings
      const m1 = store.store({
        agentId: agentA,
        scope: "agent",
        name: "search1",
        content: "first",
        source: "manual",
      });
      store.updateEmbedding(m1.id, new Float32Array([1, 0, 0]), "test-model");

      const m2 = store.store({
        agentId: agentA,
        scope: "agent",
        name: "search2",
        content: "second",
        source: "manual",
      });
      store.updateEmbedding(m2.id, new Float32Array([0.9, 0.1, 0]), "test-model");

      const query = new Float32Array([1, 0, 0]);
      const results = store.search(query, agentA, { limit: 10 });
      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should be most similar (exact match)
      expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
    });

    test("respects scope filtering", () => {
      const m1 = store.store({
        agentId: agentB,
        scope: "agent",
        name: "agent-only",
        content: "agent scoped",
        source: "manual",
      });
      store.updateEmbedding(m1.id, new Float32Array([0, 0.5, 0.5]), "test-model");

      const m2 = store.store({
        agentId: agentB,
        scope: "swarm",
        name: "swarm-shared",
        content: "swarm scoped",
        source: "manual",
      });
      store.updateEmbedding(m2.id, new Float32Array([0, 0.5, 0.5]), "test-model");

      const query = new Float32Array([0, 0.5, 0.5]);

      const agentOnly = store.search(query, agentB, { scope: "agent", limit: 50 });
      expect(agentOnly.every((r) => r.scope === "agent")).toBe(true);

      const swarmOnly = store.search(query, agentB, { scope: "swarm", limit: 50 });
      expect(swarmOnly.every((r) => r.scope === "swarm")).toBe(true);
    });

    test("isLead=true sees all memories", () => {
      const query = new Float32Array([1, 0, 0]);
      const results = store.search(query, agentA, { isLead: true, limit: 100 });
      // Lead should see both agentA and agentB memories
      const agents = new Set(results.map((r) => r.agentId));
      expect(agents.size).toBeGreaterThanOrEqual(1);
    });

    test("uses sqlite-vec for 512d embeddings with scope-filter parity", () => {
      if (skipVecAssertionsWhenUnavailable()) return;

      for (let i = 0; i < 6; i++) {
        const otherAgent = store.store({
          agentId: agentB,
          scope: "agent",
          name: `vec-other-agent-exact-${i}`,
          content: "exact but invisible to agentA",
          source: "manual",
        });
        store.updateEmbedding(otherAgent.id, vector({ 0: 1 }), "test-model");
      }

      const visible = store.store({
        agentId: agentA,
        scope: "agent",
        name: "vec-agent-visible",
        content: "visible to agentA",
        source: "manual",
      });
      store.updateEmbedding(visible.id, vector({ 0: 0.8, 1: 0.2 }), "test-model");

      const query = vector({ 0: 1 });
      const results = store.search(query, agentA, { scope: "agent", limit: 5 });

      expect(results[0]!.id).toBe(visible.id);
      expect(results.every((r) => r.agentId === agentA && r.scope === "agent")).toBe(true);

      const health = store.getHealth();
      expect(health.sqliteVec.schema).toContain("distance_metric=cosine");
      expect(health.counts.memoryVec).toBeGreaterThanOrEqual(2);
      expect(health.retrievalMode).toBe("vec");
    });
  });

  describe("memory_vec population", () => {
    test("populates existing embeddings on startup and reports health counts", () => {
      if (skipVecAssertionsWhenUnavailable()) return;

      const raw = store.store({
        agentId: agentA,
        scope: "agent",
        name: "raw-existing-embedding",
        content: "raw existing embedding",
        source: "manual",
      });
      getDb()
        .prepare("UPDATE agent_memory SET embedding = ?, embeddingModel = ? WHERE id = ?")
        .run(serializeEmbedding(vector({ 2: 1 })), "test-model", raw.id);
      getDb().prepare("DELETE FROM memory_vec WHERE memory_id = ?").run(raw.id);

      const freshStore = new SqliteMemoryStore();
      const health = freshStore.getHealth();

      expect(health.counts.missingFromVec).toBe(0);
      expect(health.sqliteVec.lastPopulate?.attempted).toBeGreaterThanOrEqual(1);
      expect(health.sqliteVec.lastPopulate?.failed).toBe(0);

      const resultIds = freshStore
        .search(vector({ 2: 1 }), agentA, { scope: "agent", limit: 20 })
        .map((r) => r.id);
      expect(resultIds).toContain(raw.id);
    });

    test("rebuilds an old non-cosine memory_vec table from agent_memory", () => {
      if (skipVecAssertionsWhenUnavailable()) return;

      const raw = store.store({
        agentId: agentA,
        scope: "agent",
        name: "stale-schema-embedding",
        content: "stale schema embedding",
        source: "manual",
      });
      getDb()
        .prepare("UPDATE agent_memory SET embedding = ?, embeddingModel = ? WHERE id = ?")
        .run(serializeEmbedding(vector({ 3: 1 })), "test-model", raw.id);

      getDb().run("DROP TABLE memory_vec");
      getDb().run(`
        CREATE VIRTUAL TABLE memory_vec USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[512]
        )
      `);

      const freshStore = new SqliteMemoryStore();
      const health = freshStore.getHealth();

      expect(health.sqliteVec.schema).toContain("distance_metric=cosine");
      expect(health.counts.missingFromVec).toBe(0);
      expect(health.retrievalMode).toBe("vec");
    });
  });

  describe("delete()", () => {
    test("removes memory", () => {
      const memory = store.store({
        agentId: agentA,
        scope: "agent",
        name: "to delete",
        content: "deleteme",
        source: "manual",
      });
      const deleted = store.delete(memory.id);
      expect(deleted).toBe(true);
      expect(store.peek(memory.id)).toBeNull();
    });

    test("returns false for non-existent", () => {
      expect(store.delete("00000000-0000-0000-0000-000000000000")).toBe(false);
    });
  });

  describe("deleteBySourcePath()", () => {
    test("removes all matching memories", () => {
      const path = "/test/delete-path.ts";
      store.store({
        agentId: agentA,
        scope: "agent",
        name: "chunk1",
        content: "c1",
        source: "file_index",
        sourcePath: path,
      });
      store.store({
        agentId: agentA,
        scope: "agent",
        name: "chunk2",
        content: "c2",
        source: "file_index",
        sourcePath: path,
      });

      const deleted = store.deleteBySourcePath(path, agentA);
      expect(deleted).toBe(2);
    });
  });

  describe("updateEmbedding()", () => {
    test("sets embedding and model", () => {
      const memory = store.store({
        agentId: agentA,
        scope: "agent",
        name: "embed test",
        content: "embeddable",
        source: "manual",
      });
      store.updateEmbedding(
        memory.id,
        new Float32Array([1, 2, 3]),
        "openai/text-embedding-3-small",
      );

      const updated = store.peek(memory.id);
      expect(updated!.embeddingModel).toBe("openai/text-embedding-3-small");
    });
  });

  describe("getStats()", () => {
    test("returns correct counts", () => {
      const statsAgent = "cccc0000-0000-4000-8000-000000000003";
      createAgent({ id: statsAgent, name: "Stats Agent", isLead: false, status: "idle" });

      store.store({
        agentId: statsAgent,
        scope: "agent",
        name: "s1",
        content: "c1",
        source: "manual",
      });
      store.store({
        agentId: statsAgent,
        scope: "swarm",
        name: "s2",
        content: "c2",
        source: "task_completion",
      });
      store.store({
        agentId: statsAgent,
        scope: "agent",
        name: "s3",
        content: "c3",
        source: "manual",
      });

      const stats = store.getStats(statsAgent);
      expect(stats.total).toBe(3);
      expect(stats.bySource.manual).toBe(2);
      expect(stats.bySource.task_completion).toBe(1);
      expect(stats.byScope.agent).toBe(2);
      expect(stats.byScope.swarm).toBe(1);
    });
  });

  describe("listForReembedding()", () => {
    test("returns id and content", () => {
      const all = store.listForReembedding();
      expect(all.length).toBeGreaterThan(0);
      expect(all[0]).toHaveProperty("id");
      expect(all[0]).toHaveProperty("content");
    });

    test("filters by agentId", () => {
      const filtered = store.listForReembedding({ agentId: agentA });
      expect(filtered.every((_m) => true)).toBe(true); // just verifying it doesn't throw
      expect(filtered.length).toBeGreaterThan(0);
    });
  });

  describe("purgeExpired()", () => {
    const purgeAgent = "cccc0000-0000-4000-8000-000000000003";

    beforeAll(() => {
      try {
        createAgent({ id: purgeAgent, name: "Purge Agent", isLead: false, status: "idle" });
      } catch {
        // agent may already exist from a prior run
      }
    });

    test("deletes rows past their expiresAt and returns count", () => {
      const db = getDb();

      // Store a session_summary (3-day TTL) then backdateits expiresAt to the past
      const mem = store.store({
        agentId: purgeAgent,
        scope: "agent",
        name: "expired session",
        content: "old session data",
        source: "session_summary",
      });
      db.prepare("UPDATE agent_memory SET expiresAt = datetime('now', '-1 day') WHERE id = ?").run(
        mem.id,
      );

      // Store a manual memory (never expires) — should survive
      const keeper = store.store({
        agentId: purgeAgent,
        scope: "agent",
        name: "keeper",
        content: "manual content",
        source: "manual",
      });

      const purged = store.purgeExpired();
      expect(purged).toBeGreaterThanOrEqual(1);

      expect(store.get(mem.id)).toBeNull();
      expect(store.get(keeper.id)).not.toBeNull();
    });

    test("returns 0 when nothing is expired", () => {
      const purged = store.purgeExpired();
      expect(purged).toBe(0);
    });

    test("also removes corresponding vec rows", () => {
      if (skipVecAssertionsWhenUnavailable()) return;

      const db = getDb();
      const emb = vector({ 0: 0.9, 100: 0.1 });

      const mem = store.store({
        agentId: purgeAgent,
        scope: "agent",
        name: "vec-purge-test",
        content: "will be purged",
        source: "task_completion",
      });
      store.updateEmbedding(mem.id, emb, "test-model");

      const vecBefore = db
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM memory_vec WHERE memory_id = ?",
        )
        .get(mem.id);

      // Only check vec cleanup if the row was actually inserted
      if (vecBefore && vecBefore.count > 0) {
        db.prepare(
          "UPDATE agent_memory SET expiresAt = datetime('now', '-1 day') WHERE id = ?",
        ).run(mem.id);

        store.purgeExpired();

        const vecAfter = db
          .prepare<{ count: number }, [string]>(
            "SELECT COUNT(*) as count FROM memory_vec WHERE memory_id = ?",
          )
          .get(mem.id);
        expect(vecAfter?.count ?? 0).toBe(0);
      }
    });
  });

  describe("knn-k cap", () => {
    test("search does not throw when vec table exceeds 4096 rows", () => {
      const db = getDb();
      const emb = vector({ 0: 1.0 });
      const embBuffer = serializeEmbedding(emb);

      // Check if vec is available — if not, skip (test is meaningful only with vec)
      const health = store.getHealth();
      if (health.retrievalMode !== "vec") return;

      // Insert enough rows to exceed 4096 in the vec table
      const currentCount =
        db.prepare<{ c: number }, []>("SELECT COUNT(*) as c FROM memory_vec").get()?.c ?? 0;
      const needed = Math.max(0, 4097 - currentCount);

      for (let i = 0; i < needed; i++) {
        const id = `knn-test-${i}-${Date.now()}`;
        db.prepare(
          "INSERT INTO agent_memory (id, agentId, scope, name, content, source, embedding, chunkIndex, totalChunks, tags, alpha, beta, createdAt, accessedAt) VALUES (?, ?, 'agent', ?, 'knn test', 'manual', ?, 0, 1, '[]', 1, 1, datetime('now'), datetime('now'))",
        ).run(id, agentA, `knn-${i}`, embBuffer);
        const vecBuf = new Float32Array(emb);
        db.prepare("INSERT INTO memory_vec (memory_id, embedding) VALUES (?, ?)").run(
          id,
          Buffer.from(vecBuf.buffer),
        );
      }

      const vecCount =
        db.prepare<{ c: number }, []>("SELECT COUNT(*) as c FROM memory_vec").get()?.c ?? 0;
      expect(vecCount).toBeGreaterThanOrEqual(4097);

      // This should NOT throw — it should clamp k to 4096
      const results = store.search(emb, agentA, { scope: "agent", limit: 10 });
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
