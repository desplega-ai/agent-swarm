import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { expandCandidatesWithGraph } from "../be/memory/graph-expansion";
import { storeLinks } from "../be/memory/link-resolver";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { recordRetrievals } from "../be/memory/raters/retrieval";
import { rerank } from "../be/memory/reranker";
import type { MemoryCandidate } from "../be/memory/types";
import type { AgentMemory } from "../types";

const TEST_DB_PATH = "./test-memory-graph-expansion.sqlite";
const agentId = "aaaa0000-0000-4000-8000-000000000201";
const otherAgentId = "aaaa0000-0000-4000-8000-000000000202";
const taskId = "bbbb0000-0000-4000-8000-000000000201";

function vector(dim: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[dim] = 1;
  return embedding;
}

function asCandidate(
  memory: AgentMemory,
  similarity: number,
  extra: Partial<MemoryCandidate> = {},
): MemoryCandidate {
  return {
    ...memory,
    similarity,
    accessCount: memory.accessCount ?? 0,
    expiresAt: memory.expiresAt ?? null,
    embeddingModel: memory.embeddingModel ?? null,
    alpha: 1.0,
    beta: 1.0,
    ...extra,
  };
}

function insertLink(
  fromMemoryId: string,
  targetId: string,
  opts: { strength?: number; sourceText?: string } = {},
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO memory_link
         (id, from_memory_id, linkType, targetKind, targetId, strength, resolver, sourceText, metadata, createdAt, updatedAt)
       VALUES (?, ?, 'wikilink', 'memory', ?, ?, 'wikilink', ?, NULL, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      fromMemoryId,
      targetId,
      opts.strength ?? 1.0,
      opts.sourceText ?? `[[${targetId}]]`,
      now,
      now,
    );
}

describe("memory graph expansion", () => {
  let store: SqliteMemoryStore;
  let prevFlag: string | undefined;

  beforeAll(async () => {
    prevFlag = process.env.MEMORY_GRAPH_EXPANSION;
    process.env.MEMORY_GRAPH_EXPANSION = "1";
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentId, name: "Graph Test Agent", isLead: false, status: "idle" });
    createAgent({ id: otherAgentId, name: "Other Graph Agent", isLead: false, status: "idle" });
    const nowIso = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
         VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
      )
      .run(taskId, agentId, "graph expansion provenance task", nowIso, nowIso);
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.MEMORY_GRAPH_EXPANSION;
    else process.env.MEMORY_GRAPH_EXPANSION = prevFlag;
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("linked memory surfaces in results it would not reach by similarity alone", () => {
    // B first so A's wikilink resolves to B's id at storeLinks time.
    const memoryB = store.store({
      agentId,
      scope: "agent",
      name: "graph-beta-note",
      content: "Completely unrelated lexical territory: sourdough hydration ratios.",
      source: "manual",
    });
    const memoryA = store.store({
      agentId,
      scope: "agent",
      name: "graph-alpha-note",
      content: "Auth flow gotchas. See also [[graph-beta-note]] for the sequel.",
      source: "manual",
    });
    // A is semantically near the query vector; B is orthogonal (cosine 0 → below MIN_SIMILARITY).
    store.updateEmbedding(memoryA.id, vector(0), "test");
    store.updateEmbedding(memoryB.id, vector(1), "test");
    storeLinks(memoryA.id, agentId, memoryA.content);

    const candidates = store.search(vector(0), agentId, { scope: "all", limit: 10 });
    expect(candidates.some((c) => c.id === memoryA.id)).toBe(true);
    expect(candidates.some((c) => c.id === memoryB.id)).toBe(false);

    const expanded = expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
    const neighbor = expanded.find((c) => c.id === memoryB.id);
    expect(neighbor).toBeDefined();
    expect(neighbor!.retrievalSource).toBe("graph");
    expect(neighbor!.recencyDecayApplied).toBe(false);
    const parent = candidates.find((c) => c.id === memoryA.id)!;
    expect(neighbor!.similarity).toBeCloseTo(parent.similarity * 1.0 * 0.7, 6);

    // The reranker keeps the graph hit in the final list (fresh manual memory → decay 1.0).
    const ranked = rerank(expanded, { limit: 10 });
    expect(ranked.some((r) => r.id === memoryB.id && r.retrievalSource === "graph")).toBe(true);
  });

  test("unresolved wikilink targets are skipped", () => {
    const memory = store.store({
      agentId,
      scope: "agent",
      name: "graph-dangling-note",
      content: "References a memory that does not exist: [[Ghost Memory Nobody Wrote]].",
      source: "manual",
    });
    storeLinks(memory.id, agentId, memory.content);

    // The link row exists, but its targetId is still the raw name text.
    const linkRows = getDb()
      .prepare<{ targetId: string }, [string]>(
        "SELECT targetId FROM memory_link WHERE from_memory_id = ?",
      )
      .all(memory.id);
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]!.targetId).toBe("Ghost Memory Nobody Wrote");

    const candidates = [asCandidate(memory, 0.9, { retrievalSource: "vec" })];
    const expanded = expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
    expect(expanded.map((c) => c.id)).toEqual([memory.id]);
  });

  test("cross-agent agent-scoped neighbor is not leaked (ACL), swarm-scoped is visible", () => {
    const parent = store.store({
      agentId,
      scope: "agent",
      name: "graph-acl-parent",
      content: "Parent memory for ACL checks.",
      source: "manual",
    });
    const secret = store.store({
      agentId: otherAgentId,
      scope: "agent",
      name: "graph-acl-secret",
      content: "Another agent's private memory.",
      source: "manual",
    });
    const shared = store.store({
      agentId: otherAgentId,
      scope: "swarm",
      name: "graph-acl-shared",
      content: "Another agent's swarm-shared memory.",
      source: "manual",
    });
    insertLink(parent.id, secret.id);
    insertLink(parent.id, shared.id);

    const candidates = [asCandidate(parent, 0.8, { retrievalSource: "vec" })];
    const expanded = expandCandidatesWithGraph(candidates, agentId, { scope: "all" });

    expect(expanded.some((c) => c.id === secret.id)).toBe(false);
    const sharedNeighbor = expanded.find((c) => c.id === shared.id);
    expect(sharedNeighbor).toBeDefined();
    expect(sharedNeighbor!.retrievalSource).toBe("graph");
  });

  test("flag off returns the input candidates unchanged (byte-identical)", () => {
    const parent = store.store({
      agentId,
      scope: "agent",
      name: "graph-flagoff-parent",
      content: "Parent for flag-off test.",
      source: "manual",
    });
    const neighbor = store.store({
      agentId,
      scope: "agent",
      name: "graph-flagoff-neighbor",
      content: "Neighbor that must NOT appear when the flag is off.",
      source: "manual",
    });
    insertLink(parent.id, neighbor.id);

    const candidates = [asCandidate(parent, 0.9, { retrievalSource: "vec" })];
    const snapshot = JSON.stringify(candidates);

    process.env.MEMORY_GRAPH_EXPANSION = "0";
    try {
      const result = expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
      expect(result).toBe(candidates); // same reference — nothing touched
      expect(JSON.stringify(result)).toBe(snapshot);
    } finally {
      process.env.MEMORY_GRAPH_EXPANSION = "1";
    }

    // Sanity: with the flag back on, the same input DOES gain the neighbor.
    const expanded = expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
    expect(expanded.some((c) => c.id === neighbor.id)).toBe(true);
  });

  test("dedupe keeps the higher-scored entry", () => {
    const parent = store.store({
      agentId,
      scope: "agent",
      name: "graph-dedupe-parent",
      content: "Parent for dedupe test.",
      source: "manual",
    });
    const neighbor = store.store({
      agentId,
      scope: "agent",
      name: "graph-dedupe-neighbor",
      content: "Neighbor also present organically.",
      source: "manual",
    });
    insertLink(parent.id, neighbor.id);

    // Graph-derived score (0.9 × 1.0 × 0.7 = 0.63) beats the weak organic hit (0.1).
    const weakOrganic = [
      asCandidate(parent, 0.9, { retrievalSource: "vec" }),
      asCandidate(neighbor, 0.1, { retrievalSource: "vec" }),
    ];
    const expandedWeak = expandCandidatesWithGraph(weakOrganic, agentId, { scope: "all" });
    expect(expandedWeak).toHaveLength(2);
    const replaced = expandedWeak.find((c) => c.id === neighbor.id)!;
    expect(replaced.retrievalSource).toBe("graph");
    expect(replaced.similarity).toBeCloseTo(0.63, 6);

    // Strong organic hit (0.9) beats the graph-derived score (0.2 × 0.7 = 0.14).
    const strongOrganic = [
      asCandidate(parent, 0.2, { retrievalSource: "vec" }),
      asCandidate(neighbor, 0.9, { retrievalSource: "vec" }),
    ];
    const expandedStrong = expandCandidatesWithGraph(strongOrganic, agentId, { scope: "all" });
    expect(expandedStrong).toHaveLength(2);
    const kept = expandedStrong.find((c) => c.id === neighbor.id)!;
    expect(kept.retrievalSource).toBe("vec");
    expect(kept.similarity).toBeCloseTo(0.9, 6);
  });

  test("memory_retrieval rows carry retrievalSource='graph'", () => {
    const parent = store.store({
      agentId,
      scope: "agent",
      name: "graph-provenance-parent",
      content: "Parent for provenance test.",
      source: "manual",
    });
    const neighbor = store.store({
      agentId,
      scope: "agent",
      name: "graph-provenance-neighbor",
      content: "Neighbor whose retrieval row must say graph.",
      source: "manual",
    });
    insertLink(parent.id, neighbor.id);

    // Mirror the call-site seam: search-shaped candidates → expand → rerank → record.
    const candidates = [asCandidate(parent, 0.9, { retrievalSource: "vec" })];
    const ranked = rerank(expandCandidatesWithGraph(candidates, agentId, { scope: "all" }), {
      limit: 10,
    });
    recordRetrievals(
      taskId,
      agentId,
      ranked.map((r) => ({
        memoryId: r.id,
        similarity: r.similarity,
        retrievalSource: r.retrievalSource,
      })),
      undefined,
      { intent: "graph provenance test", eventType: "search" },
    );

    const rows = getDb()
      .prepare<{ memoryId: string; retrievalSource: string | null }, [string]>(
        "SELECT memoryId, retrievalSource FROM memory_retrieval WHERE taskId = ?",
      )
      .all(taskId);
    expect(rows.find((r) => r.memoryId === neighbor.id)?.retrievalSource).toBe("graph");
    expect(rows.find((r) => r.memoryId === parent.id)?.retrievalSource).toBe("vec");
  });

  test("damping and cap are respected", () => {
    const parent = store.store({
      agentId,
      scope: "agent",
      name: "graph-capdamp-parent",
      content: "Parent for damping/cap test.",
      source: "manual",
    });
    const strengths = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
    const neighborIds: string[] = [];
    for (const [i, strength] of strengths.entries()) {
      const neighbor = store.store({
        agentId,
        scope: "agent",
        name: `graph-capdamp-neighbor-${i}`,
        content: `Neighbor ${i} for damping/cap test.`,
        source: "manual",
      });
      neighborIds.push(neighbor.id);
      insertLink(parent.id, neighbor.id, { strength });
    }

    const candidates = [asCandidate(parent, 0.8, { retrievalSource: "vec" })];

    // Custom damping: similarity = parentSim × strength × damping.
    const damped = expandCandidatesWithGraph(candidates, agentId, {
      scope: "all",
      damping: 0.5,
      cap: 1,
    });
    expect(damped).toHaveLength(2);
    const top = damped.find((c) => c.id === neighborIds[0])!;
    expect(top.similarity).toBeCloseTo(0.8 * 0.9 * 0.5, 6);

    // Cap 3 → exactly three additions, and they are the top-3 by derived score.
    const capped = expandCandidatesWithGraph(candidates, agentId, { scope: "all", cap: 3 });
    expect(capped).toHaveLength(4);
    const addedIds = capped.slice(1).map((c) => c.id);
    expect(new Set(addedIds)).toEqual(new Set(neighborIds.slice(0, 3)));

    // Default cap (5) → five additions out of seven linked neighbors.
    const defaulted = expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
    expect(defaulted).toHaveLength(6);
  });
});
