import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import * as realMemoryModule from "../be/memory";
import { expandCandidatesWithGraph } from "../be/memory/graph-expansion";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { rerank } from "../be/memory/reranker";
import { memoryRelevance, renderMemoriesPrompt, SIMILARITY_THRESHOLD } from "../prompts/memories";

// Crowd-out regression (PR #1689 review): graph neighbours get their own
// access and source boosts, so five boosted neighbours of one direct hit
// out-scored it on the composite, filled all five slots of the runner's
// `limit: 5` recall, and all failed the relevance gate. The rendered prompt
// was null while an eligible direct hit existed. Everything below the query
// embedding is real: SQLite store, hybrid fusion, graph expansion, reranker,
// the HTTP handler's selection, and the runner's prompt renderer.

// Capture the real exports BEFORE mock.module patches the registry entry.
const realMemoryExports = {
  getEmbeddingProvider: realMemoryModule.getEmbeddingProvider,
  getMemoryStore: realMemoryModule.getMemoryStore,
};

const TEST_DB_PATH = "./test-memory-prompt-recall-crowdout.sqlite";
const agentId = randomUUID();
const sourceTaskId = randomUUID();
const PARENT_NAME = "crowdoutparentexactname";
const NEIGHBOR_COUNT = 5;

/** Unit vector: `cos` on axis 2 (the query axis), the remainder on `axis`. */
function mix(cos: number, axis: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[2] = cos;
  embedding[axis] = Math.sqrt(1 - cos * cos);
  return embedding;
}

const queryEmbedding = mix(1, 3);

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test",
    dimensions: 512,
    embed: async () => queryEmbedding,
    embedBatch: async (texts: string[]) => texts.map(() => queryEmbedding),
  }),
  getMemoryStore: () => new SqliteMemoryStore(),
}));

const { handleMemory } = await import("../http/memory");

let parentId: string;
const neighborIds: string[] = [];
let prevHybridFlag: string | undefined;

async function promptRecall(
  callerAgentId: string = agentId,
  query: string = PARENT_NAME,
): Promise<{
  results: Array<{
    id: string;
    name: string;
    content: string;
    similarity: number;
    rawSimilarity?: number;
    retrievalSource?: string;
  }>;
}> {
  // Byte-for-byte the runner's pre-task recall request (fetchRelevantMemories).
  const body = { query, limit: 5, intent: "pre-task memory recall" };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = "/api/memory/search";
  req.headers = {
    "x-source-task-id": sourceTaskId,
    "x-context-key": "task:crowdout",
    "x-memory-consumption": "prompt",
  };
  let payload: any = null;
  const res = {
    writeHead() {
      return this;
    },
    end(chunk?: unknown) {
      payload = typeof chunk === "string" ? JSON.parse(chunk) : chunk;
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await handleMemory(req, res, ["api", "memory", "search"], callerAgentId);
  expect(handled).toBe(true);
  return payload;
}

beforeAll(async () => {
  prevHybridFlag = process.env.MEMORY_HYBRID_SEARCH;
  process.env.MEMORY_HYBRID_SEARCH = "1";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  await createAgent({ id: agentId, name: "Crowd-out Agent", isLead: false, status: "idle" });
  const nowIso = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    [sourceTaskId, agentId, "crowd-out recall task", nowIso, nowIso],
  );

  const store = new SqliteMemoryStore();
  // Fresh manual parent, cosine 0.7, matched by both arms, never accessed.
  const parent = await store.store({
    agentId,
    scope: "agent",
    name: PARENT_NAME,
    content: "The direct hit this recall is looking for.",
    source: "manual",
  });
  parentId = parent.id;
  await store.updateEmbedding(parentId, mix(0.7, 4), "test");

  // Five fresh manual neighbours, each linked at strength 1 and independently
  // boosted by five recent accesses. Their own cosine is low; only the graph
  // arm can surface them.
  for (let i = 0; i < NEIGHBOR_COUNT; i++) {
    const neighbor = await store.store({
      agentId,
      scope: "agent",
      name: `linked note ${i}`,
      content: `Linked follow-up note number ${i}.`,
      source: "manual",
    });
    neighborIds.push(neighbor.id);
    await store.updateEmbedding(neighbor.id, mix(0.1, 10 + i), "test");
    await getDbClient().run(
      `INSERT INTO memory_link
         (id, from_memory_id, linkType, targetKind, targetId, strength, resolver, sourceText, metadata, createdAt, updatedAt)
       VALUES (?, ?, 'wikilink', 'memory', ?, 1.0, 'wikilink', ?, NULL, ?, ?)`,
      [randomUUID(), parentId, neighbor.id, `note ${i}`, nowIso, nowIso],
    );
  }
});

afterAll(async () => {
  // bun's mock.module is process-global and never auto-restored.
  mock.module("../be/memory", () => realMemoryExports);
  if (prevHybridFlag === undefined) delete process.env.MEMORY_HYBRID_SEARCH;
  else process.env.MEMORY_HYBRID_SEARCH = prevHybridFlag;
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("pre-task recall with independently boosted graph neighbours", () => {
  // Set boosts before each test: prompt recall records accesses on the rows it
  // injects, so a previous test would otherwise shift the fixture.
  async function boostFixture(): Promise<void> {
    const nowIso = new Date().toISOString();
    await getDbClient().run(
      "UPDATE agent_memory SET accessCount = 0, accessedAt = ? WHERE id = ?",
      [nowIso, parentId],
    );
    for (const id of neighborIds) {
      await getDbClient().run(
        "UPDATE agent_memory SET accessCount = 5, accessedAt = ? WHERE id = ?",
        [nowIso, id],
      );
    }
  }

  test("fixture reproduces the review: the neighbours alone out-score the eligible parent", async () => {
    await boostFixture();
    const candidates = await new SqliteMemoryStore().search(queryEmbedding, agentId, {
      scope: "all",
      limit: 15,
      queryText: PARENT_NAME,
    });
    const expanded = await expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
    const scored = expanded.map((c) => ({ c, score: rerank([c], { limit: 1 })[0]! }));
    const parent = scored.find((s) => s.c.id === parentId)!;
    const neighbors = scored.filter((s) => neighborIds.includes(s.c.id));

    expect(parent.c.retrievalSource).toBe("hybrid");
    expect(memoryRelevance(parent.score)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(neighbors).toHaveLength(NEIGHBOR_COUNT);
    for (const n of neighbors) {
      expect(n.c.retrievalSource).toBe("graph");
      expect(memoryRelevance(n.score)).toBeLessThan(SIMILARITY_THRESHOLD);
      // Scored in isolation, each neighbour's boosted composite beats the parent's.
      expect(n.score.compositeScore!).toBeGreaterThan(parent.score.compositeScore!);
    }
  });

  test("a parent outranks its own boosted graph neighbours in the reranked top five", async () => {
    await boostFixture();
    const candidates = await new SqliteMemoryStore().search(queryEmbedding, agentId, {
      scope: "all",
      limit: 15,
      queryText: PARENT_NAME,
    });
    const expanded = await expandCandidatesWithGraph(candidates, agentId, { scope: "all" });
    const ranked = rerank(expanded, { limit: 5 });
    expect(ranked[0]!.id).toBe(parentId);
    const parentScore = ranked[0]!.compositeScore!;
    for (const r of ranked.slice(1)) {
      if (neighborIds.includes(r.id)) expect(r.compositeScore!).toBeLessThanOrEqual(parentScore);
    }
  });

  test("the runner's five-slot prompt recall injects the parent instead of rendering null", async () => {
    await boostFixture();
    const { results } = await promptRecall();
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results[0]!.id).toBe(parentId);

    const prompt = renderMemoriesPrompt(results);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(parentId);
    for (const id of neighborIds) expect(prompt).not.toContain(id);

    const recorded = await getDbClient().query<{ memoryId: string; relevance: number | null }>(
      "SELECT memoryId, relevance FROM memory_retrieval WHERE taskId = ?",
      [sourceTaskId],
    );
    expect(recorded.map((r) => r.memoryId)).toContain(parentId);
    const access = await getDbClient().get<{ accessCount: number }>(
      "SELECT accessCount FROM agent_memory WHERE id = ?",
      [parentId],
    );
    expect(access!.accessCount).toBe(1);
  });

  test("boosted low-relevance direct rows do not take the slots of an eligible hit", async () => {
    // No graph here: an eligible task_completion hit (0.7x source quality)
    // against five manual rows that match only on the vector arm and carry
    // five recent accesses each. The composite puts all five above the hit;
    // the prompt selection must still give the hit a slot.
    const otherAgentId = randomUUID();
    const hitName = "crowdoutsecondexactname";
    await createAgent({
      id: otherAgentId,
      name: "Crowd-out Agent 2",
      isLead: false,
      status: "idle",
    });
    const store = new SqliteMemoryStore();
    const hit = await store.store({
      agentId: otherAgentId,
      scope: "agent",
      name: hitName,
      content: "An eligible hit from a completed task.",
      source: "task_completion",
    });
    await store.updateEmbedding(hit.id, mix(0.75, 4), "test");
    const boostedIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (let i = 0; i < NEIGHBOR_COUNT; i++) {
      const row = await store.store({
        agentId: otherAgentId,
        scope: "agent",
        name: `unrelated manual ${i}`,
        content: `Loosely related manual note ${i}.`,
        source: "manual",
      });
      boostedIds.push(row.id);
      await store.updateEmbedding(row.id, mix(0.5, 20 + i), "test");
      await getDbClient().run(
        "UPDATE agent_memory SET accessCount = 5, accessedAt = ? WHERE id = ?",
        [nowIso, row.id],
      );
    }

    const candidates = await store.search(queryEmbedding, otherAgentId, {
      scope: "all",
      limit: 15,
      queryText: hitName,
    });
    const byComposite = rerank(candidates, { limit: 5 });
    expect(byComposite.map((r) => r.id)).not.toContain(hit.id);

    const { results } = await promptRecall(otherAgentId, hitName);
    expect(results).toHaveLength(5);
    expect(results[0]!.id).toBe(hit.id);
    expect(memoryRelevance(results[0]!)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    const prompt = renderMemoriesPrompt(results);
    expect(prompt).toContain(hit.id);
    for (const id of boostedIds) expect(prompt).not.toContain(id);
  });
});
