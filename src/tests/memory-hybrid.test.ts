import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb, isSqliteVecAvailable } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

const TEST_DB_PATH = "./test-memory-hybrid.sqlite";

describe("Memory hybrid search (FTS5 + RRF)", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000101";
  let store: SqliteMemoryStore;

  function vector(values: Record<number, number>): Float32Array {
    const embedding = new Float32Array(512);
    for (const [index, value] of Object.entries(values)) {
      embedding[Number(index)] = value;
    }
    return embedding;
  }

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "Hybrid Agent", isLead: false, status: "idle" });
    store = new SqliteMemoryStore();

    // Seed some memories with unique content for FTS matching
    store.store({
      agentId: agentA,
      scope: "agent",
      name: "Kubernetes deployment guide",
      content: "Use kubectl apply to deploy pods and services to the kubernetes cluster.",
      source: "manual",
      sourcePath: "/docs/k8s-deploy.md",
    });
    store.store({
      agentId: agentA,
      scope: "agent",
      name: "Database migration procedure",
      content: "Run forward-only SQL migrations on SQLite. Never modify applied migrations.",
      source: "manual",
      sourcePath: "/docs/db-migrations.md",
    });
    store.store({
      agentId: agentA,
      scope: "agent",
      name: "Authentication flow",
      content: "Bearer tokens authenticate API requests via the Authorization header.",
      source: "manual",
      sourcePath: "/docs/auth-flow.md",
    });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  describe("FTS5 table lifecycle", () => {
    test("FTS initialized in health report", () => {
      const health = store.getHealth();
      expect(health.fts.initialized).toBe(true);
    });

    test("FTS table is populated on construction", () => {
      const count = getDb()
        .prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_fts")
        .get();
      expect(count!.count).toBeGreaterThanOrEqual(3);
    });
  });

  describe("searchFts (FTS-only path)", () => {
    test("finds memory by content keyword", () => {
      // queryText only, no valid embedding → FTS-only path
      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "kubernetes",
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.name).toContain("Kubernetes");
    });

    test("finds memory by name keyword", () => {
      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "migration",
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const names = results.map((r) => r.name);
      expect(names).toContain("Database migration procedure");
    });

    test("returns empty for non-matching query", () => {
      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "xyznonexistent",
      });
      expect(results).toHaveLength(0);
    });

    test("returns empty for query with only special characters", () => {
      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "!@#$%^&*()",
      });
      expect(results).toHaveLength(0);
    });

    test("respects scope filter", () => {
      // Store a swarm-scoped memory
      store.store({
        agentId: agentA,
        scope: "swarm",
        name: "Swarm-only kubernetes note",
        content: "kubernetes global configuration for the whole swarm.",
        source: "manual",
        sourcePath: `/docs/swarm-k8s-${crypto.randomUUID().slice(0, 8)}.md`,
      });

      const agentResults = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "kubernetes",
      });
      const allNames = agentResults.map((r) => r.name);
      expect(allNames).not.toContain("Swarm-only kubernetes note");
    });
  });

  describe("FTS sync on store/delete", () => {
    test("new memory appears in FTS", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "Ephemeral FTS test",
        content: "supercalifragilistic unique word for FTS test.",
        source: "manual",
        sourcePath: `/docs/ephemeral-fts-${crypto.randomUUID().slice(0, 8)}.md`,
      });

      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "supercalifragilistic",
      });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(mem.id);
    });

    test("deleted memory is removed from FTS", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "To be deleted",
        content: "deletemenow unique phrase for FTS.",
        source: "manual",
        sourcePath: `/docs/to-delete-${crypto.randomUUID().slice(0, 8)}.md`,
      });

      store.delete(mem.id);

      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "deletemenow",
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("searchHybrid (RRF fusion)", () => {
    test("hybrid path fires when vec + queryText both available", () => {
      if (!isSqliteVecAvailable()) return;

      // Give one memory a valid 512d embedding so vec search can find it
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "Hybrid target",
        content: "prometheus monitoring and alerting toolkit integration.",
        source: "manual",
        sourcePath: `/docs/hybrid-target-${crypto.randomUUID().slice(0, 8)}.md`,
      });

      const emb = vector({ 0: 1.0, 1: 0.5 });
      store.updateEmbedding(mem.id, emb, "test-model");

      // Search with both embedding and queryText
      const results = store.search(emb, agentA, {
        scope: "agent",
        limit: 10,
        queryText: "prometheus",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      // The hybrid target should appear — it matches both vec and FTS
      const ids = results.map((r) => r.id);
      expect(ids).toContain(mem.id);
    });

    test("RRF boosts memories that appear in both vec and FTS results", () => {
      if (!isSqliteVecAvailable()) return;

      const suffix = crypto.randomUUID().slice(0, 8);
      const memBoth = store.store({
        agentId: agentA,
        scope: "agent",
        name: "Both signals",
        content: "grafana dashboard observability metrics and alerting configuration.",
        source: "manual",
        sourcePath: `/docs/both-signals-${suffix}.md`,
      });

      const memVecOnly = store.store({
        agentId: agentA,
        scope: "agent",
        name: "Vec only",
        content: "Some unrelated content that won't match grafana.",
        source: "manual",
        sourcePath: `/docs/vec-only-${suffix}.md`,
      });

      // Give them the same embedding so vec ranks them equally
      const emb = vector({ 0: 0.9, 1: 0.3 });
      store.updateEmbedding(memBoth.id, emb, "test-model");
      store.updateEmbedding(memVecOnly.id, emb, "test-model");

      const results = store.search(emb, agentA, {
        scope: "agent",
        limit: 10,
        queryText: "grafana dashboard",
      });

      const bothIdx = results.findIndex((r) => r.id === memBoth.id);
      const vecIdx = results.findIndex((r) => r.id === memVecOnly.id);

      // memBoth should rank higher because it matches both FTS and vec
      if (bothIdx >= 0 && vecIdx >= 0) {
        expect(bothIdx).toBeLessThan(vecIdx);
      }
    });
  });

  describe("sanitizeFtsQuery edge cases", () => {
    test("handles multi-word queries", () => {
      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "SQL migrations forward",
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("handles hyphens in queries", () => {
      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "forward-only",
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
