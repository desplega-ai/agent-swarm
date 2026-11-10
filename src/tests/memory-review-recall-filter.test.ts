import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import * as realMemoryModule from "../be/memory";
import type { MemoryCandidate, MemorySearchOptions, MemoryStore } from "../be/memory/types";
import type { AgentMemory } from "../types";

const realMemoryExports = {
  getEmbeddingProvider: realMemoryModule.getEmbeddingProvider,
  getMemoryStore: realMemoryModule.getMemoryStore,
};

const TEST_DB_PATH = "./test-memory-review-recall-filter.sqlite";
const agentId = randomUUID();

const id = {
  reviewRecaller: randomUUID(), // taskType review
  batchRecaller: randomUUID(), // pr-review-demo tag
  plainRecaller: randomUUID(),
  reviewSource: randomUUID(), // taskType review
  rereviewSource: randomUUID(), // re-review tag
  batchSource: randomUUID(), // pr-review-demo tag
  plainSource: randomUUID(), // taskType bug
};

function memory(
  name: string,
  source: AgentMemory["source"],
  sourceTaskId: string | null,
): AgentMemory {
  return {
    id: randomUUID(),
    agentId,
    key: null,
    name,
    content: `${name} content`,
    scope: "agent",
    source,
    summary: null,
    sourcePath: null,
    sourceTaskId,
    chunkIndex: 0,
    totalChunks: 1,
    tags: [],
    contextKey: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    accessedAt: "2026-11-01T00:00:00.000Z",
  };
}

// Highest similarity first: three review-sourced completions crowd the top.
const reviewCompletions = [
  memory("review-a", "task_completion", id.reviewSource),
  memory("review-b", "task_completion", id.rereviewSource),
  memory("review-c", "task_completion", id.batchSource),
];
const plainCompletion = memory("plain-completion", "task_completion", id.plainSource);
const manualNote = memory("manual-note", "manual", null);
const orphanCompletion = memory("orphan-completion", "task_completion", randomUUID());
const ranked = [...reviewCompletions, plainCompletion, manualNote, orphanCompletion];

function asCandidate(m: AgentMemory, similarity: number): MemoryCandidate {
  return {
    ...m,
    similarity,
    rawSimilarity: similarity,
    accessCount: 0,
    expiresAt: null,
    embeddingModel: "test",
    alpha: 1,
    beta: 1,
  };
}

// Honors `limit` like the real store: the top-`limit` rows by similarity.
const fakeStore = {
  search: async (_e: Float32Array, _a: string, options: MemorySearchOptions) =>
    ranked.slice(0, options.limit ?? 10).map((m, i) => asCandidate(m, 0.95 - i * 0.01)),
  list: async () => ranked,
} as unknown as MemoryStore;

mock.module("../be/memory", () => ({
  getEmbeddingProvider: () => ({
    name: "test",
    dimensions: 3,
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
  }),
  getMemoryStore: () => fakeStore,
}));

const { handleMemory } = await import("../http/memory");
const { searchMemoryCandidates } = await import("../be/memory/search-candidates");
const { dropReviewTaskCompletions, isReviewTaskId } = await import(
  "../be/memory/review-recall-filter"
);

async function insertTask(taskId: string, taskType: string | null, tags: string[]): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, taskType, tags, createdAt, lastUpdatedAt)
       VALUES (?, ?, 'task', 'completed', 'mcp', ?, ?, ?, ?)`,
    [taskId, agentId, taskType, JSON.stringify(tags), now, now],
  );
}

async function recall(recallerTaskId: string, limit = 5): Promise<string[]> {
  const req = Readable.from([
    Buffer.from(
      JSON.stringify({ query: "prompt recall", intent: "pre-task memory recall", limit }),
    ),
  ]) as IncomingMessage;
  req.method = "POST";
  req.url = "/api/memory/search";
  req.headers = { "x-memory-consumption": "prompt", "x-source-task-id": recallerTaskId };
  let body: { results: { name: string }[] } = { results: [] };
  const res = {
    writeHead() {
      return this;
    },
    end(chunk?: unknown) {
      body = JSON.parse(chunk as string);
      return this;
    },
  } as unknown as ServerResponse;
  expect(await handleMemory(req, res, ["api", "memory", "search"], agentId)).toBe(true);
  return body.results.map((r) => r.name);
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  await createAgent({ id: agentId, name: "Review Recall Agent", isLead: false, status: "idle" });
  await insertTask(id.reviewRecaller, "review", []);
  await insertTask(id.batchRecaller, null, ["pr-review-demo"]);
  await insertTask(id.plainRecaller, "bug", []);
  await insertTask(id.reviewSource, "review", []);
  await insertTask(id.rereviewSource, null, ["pr-fix-loop", "re-review"]);
  await insertTask(id.batchSource, null, ["pr-review-demo"]);
  await insertTask(id.plainSource, "bug", ["pr-fix-loop"]);
});

afterAll(async () => {
  mock.module("../be/memory", () => realMemoryExports);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("review tasks do not recall review task_completion memories", () => {
  test("recaller classification uses task fields", async () => {
    expect(await isReviewTaskId(id.reviewRecaller)).toBe(true);
    expect(await isReviewTaskId(id.batchRecaller)).toBe(true);
    expect(await isReviewTaskId(id.plainRecaller)).toBe(false);
    expect(await isReviewTaskId(randomUUID())).toBe(false);
    expect(await isReviewTaskId(undefined)).toBe(false);
  });

  test("pre-task recall for a review task drops review-sourced completions, keeps the rest", async () => {
    for (const recaller of [id.reviewRecaller, id.batchRecaller]) {
      const names = await recall(recaller);
      expect([...names].sort()).toEqual(["manual-note", "orphan-completion", "plain-completion"]);
    }
  });

  test("dropped rows free their slots for the next-ranked memories", async () => {
    // limit 1 -> 3 candidate rows, all review-sourced: the filter must widen the fetch.
    const names = await recall(id.reviewRecaller, 1);
    expect(names).toHaveLength(1);
    expect(["manual-note", "orphan-completion", "plain-completion"]).toContain(names[0]);
  });

  test("a non-review task still recalls review-sourced completions", async () => {
    const names = await recall(id.plainRecaller);
    expect(names).toEqual(expect.arrayContaining(["review-a", "review-b", "review-c"]));
  });

  test("searchMemoryCandidates only filters when asked", async () => {
    const embedding = new Float32Array([1, 0, 0]);
    const off = await searchMemoryCandidates(fakeStore, embedding, agentId, { limit: 3 });
    expect(off.map((c) => c.name)).toEqual(["review-a", "review-b", "review-c"]);
    const on = await searchMemoryCandidates(fakeStore, embedding, agentId, {
      limit: 3,
      excludeReviewTaskCompletions: true,
    });
    expect(on.map((c) => c.name)).toEqual(["plain-completion", "manual-note", "orphan-completion"]);
  });

  test("dropReviewTaskCompletions leaves non-task_completion sources alone", async () => {
    const reviewManual = memory("manual-with-review-task", "manual", id.reviewSource);
    const kept = await dropReviewTaskCompletions([reviewManual, ...reviewCompletions]);
    expect(kept.map((m) => m.name)).toEqual(["manual-with-review-task"]);
  });
});
