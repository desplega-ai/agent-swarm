import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { expandCandidatesWithGraph } from "../be/memory/graph-expansion";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { computeScore, rerank } from "../be/memory/reranker";

// PR #1689 review on 2e8c2f24: expansion replaced an organic duplicate with
// its graph route on the UNCAPPED graph score, then rerank() capped that route
// at a low-quality parent's composite. The neighbour's stronger organic match
// was gone. Fresh rows, default boosts, link strength 1, vector-only arm so
// each similarity is the fixture cosine:
// - task_completion parent: relevance 0.90, composite 0.90 x 0.7 = 0.63
// - manual neighbour, also a direct match: relevance 0.60, composite 0.90
// - unrelated manual row: relevance 0.54, composite 0.81

const TEST_DB_PATH = "./test-memory-graph-organic-route.sqlite";
const agentId = randomUUID();

/** Unit vector: `cos` on axis 2 (the query axis), the remainder on `axis`. */
function mix(cos: number, axis: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[2] = cos;
  embedding[axis] = Math.sqrt(1 - cos * cos);
  return embedding;
}

const queryEmbedding = mix(1, 3);

let parentId: string;
let neighborId: string;
let otherId: string;
let prevHybridFlag: string | undefined;
let prevGraphFlag: string | undefined;

async function searchAndExpand() {
  const candidates = await new SqliteMemoryStore().search(queryEmbedding, agentId, {
    scope: "all",
    limit: 15,
  });
  const expanded = await expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
  return { candidates, expanded };
}

beforeAll(async () => {
  prevHybridFlag = process.env.MEMORY_HYBRID_SEARCH;
  prevGraphFlag = process.env.MEMORY_GRAPH_EXPANSION;
  process.env.MEMORY_HYBRID_SEARCH = "0";
  delete process.env.MEMORY_GRAPH_EXPANSION;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  await createAgent({ id: agentId, name: "Organic Route Agent", isLead: false, status: "idle" });

  const store = new SqliteMemoryStore();
  const parent = await store.store({
    agentId,
    scope: "agent",
    name: "completed task summary",
    content: "What the task did.",
    source: "task_completion",
  });
  parentId = parent.id;
  await store.updateEmbedding(parentId, mix(0.9, 4), "test");

  const neighbor = await store.store({
    agentId,
    scope: "agent",
    name: "manual note linked from the summary",
    content: "A manual note that also matches the query directly.",
    source: "manual",
  });
  neighborId = neighbor.id;
  await store.updateEmbedding(neighborId, mix(0.6, 5), "test");

  const other = await store.store({
    agentId,
    scope: "agent",
    name: "unrelated manual note",
    content: "Another manual note.",
    source: "manual",
  });
  otherId = other.id;
  await store.updateEmbedding(otherId, mix(0.54, 6), "test");

  const nowIso = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO memory_link
       (id, from_memory_id, linkType, targetKind, targetId, strength, resolver, sourceText, metadata, createdAt, updatedAt)
     VALUES (?, ?, 'wikilink', 'memory', ?, 1.0, 'wikilink', 'note', NULL, ?, ?)`,
    [randomUUID(), parentId, neighborId, nowIso, nowIso],
  );
});

afterAll(async () => {
  if (prevHybridFlag === undefined) delete process.env.MEMORY_HYBRID_SEARCH;
  else process.env.MEMORY_HYBRID_SEARCH = prevHybridFlag;
  if (prevGraphFlag === undefined) delete process.env.MEMORY_GRAPH_EXPANSION;
  else process.env.MEMORY_GRAPH_EXPANSION = prevGraphFlag;
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("graph route of a neighbour that already matches organically", () => {
  test("fixture reproduces the review: the uncapped graph route beats the organic one, the capped route does not", async () => {
    const { candidates } = await searchAndExpand();
    const now = new Date();
    const organic = candidates.find((c) => c.id === neighborId)!;
    const parent = candidates.find((c) => c.id === parentId)!;
    expect(organic.retrievalSource).toBe("vec");
    expect(parent.retrievalSource).toBe("vec");
    expect(candidates.find((c) => c.id === otherId)?.retrievalSource).toBe("vec");

    const graphRoute = { ...organic, similarity: 0.9 * 0.7, retrievalSource: "graph" as const };
    const organicScore = computeScore(organic, now);
    const parentScore = computeScore(parent, now);
    expect(organicScore).toBeCloseTo(0.9, 2);
    expect(parentScore).toBeCloseTo(0.63, 2);
    expect(computeScore(graphRoute, now)).toBeGreaterThan(organicScore);
    expect(Math.min(computeScore(graphRoute, now), parentScore)).toBeLessThan(organicScore);
  });

  test("a low-quality parent's link does not demote a neighbour's stronger organic match", async () => {
    const { expanded } = await searchAndExpand();
    const neighbor = expanded.filter((c) => c.id === neighborId);
    expect(neighbor).toHaveLength(1);
    expect(neighbor[0]!.retrievalSource).toBe("vec");
    expect(neighbor[0]!.graphParentId).toBeUndefined();

    const [top] = rerank(expanded, { limit: 1 });
    expect(top!.id).toBe(neighborId);
    expect(top!.retrievalSource).toBe("vec");
    expect(top!.compositeScore!).toBeCloseTo(0.9, 2);
  });

  test("the result matches search without graph expansion", async () => {
    process.env.MEMORY_GRAPH_EXPANSION = "0";
    try {
      const { expanded } = await searchAndExpand();
      const [top] = rerank(expanded, { limit: 1 });
      expect(top!.id).toBe(neighborId);
      expect(top!.compositeScore!).toBeCloseTo(0.9, 2);
    } finally {
      delete process.env.MEMORY_GRAPH_EXPANSION;
    }
  });
});
