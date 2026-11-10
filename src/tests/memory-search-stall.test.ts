import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, getDbClient, initDb } from "../be/db";
import { SEARCH_HEALTH_TTL_MS, SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { searchMemoryCandidates } from "../be/memory/search-candidates";
import type { AgentMemory } from "../types";

// POST /api/memory/search stalled the API event loop for 10 to 30 s. Two causes,
// both in the store's search path:
//   1. search() ran the health counts (8 sync COUNT(*) scans) on every call,
//      plus one COUNT(*) FROM memory_vec per vec query.
//   2. a review task's recall dropped review completions after the fetch, so
//      a window full of them widened the fetch round after round.
// Everything here is real: the SQLite store and its vec, FTS and hybrid paths.

const TEST_DB_PATH = "./test-memory-search-stall.sqlite";
// One agent per describe: agent-scope rows keep the scenarios apart.
const healthAgent = randomUUID();
const reviewAgent = randomUUID();
const QUERY = "stall probe";

/** Unit vector: `cos` on axis 2 (the query axis), the remainder on `axis`. */
function mix(cos: number, axis: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[2] = cos;
  embedding[axis] = Math.sqrt(1 - cos * cos);
  return embedding;
}
const queryEmbedding = mix(1, 3);

async function insertTask(taskType: string | null, tags: string): Promise<string> {
  const agentId = reviewAgent;
  const id = randomUUID();
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, taskType, tags, createdAt, lastUpdatedAt)
       VALUES (?, ?, 'task', 'completed', 'mcp', ?, ?, ?, ?)`,
    [id, agentId, taskType, tags, now, now],
  );
  return id;
}

async function remember(
  store: SqliteMemoryStore,
  agentId: string,
  name: string,
  source: AgentMemory["source"],
  sourceTaskId: string | null,
  cos: number,
): Promise<void> {
  const row = await store.store({
    agentId,
    scope: "agent",
    name,
    content: `${QUERY} ${name}`,
    source,
    sourceTaskId: sourceTaskId ?? undefined,
  });
  await store.updateEmbedding(row.id, mix(cos, 4), "test");
}

/** Count the raw-handle statements the health counts and the vec count run. */
function watchCountScans(): { health: number; vecCount: number; stop: () => void } {
  const db = getDb();
  const realPrepare = db.prepare;
  const seen = {
    health: 0,
    vecCount: 0,
    stop: () => {
      db.prepare = realPrepare;
    },
  };
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    // getHealthCounts() runs this statement exactly once per call.
    if (sql === "SELECT COUNT(*) as count FROM agent_memory") seen.health++;
    if (sql === "SELECT COUNT(*) as count FROM memory_vec") seen.vecCount++;
    return (realPrepare as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.prepare;
  return seen;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  await createAgent({ id: healthAgent, name: "Health Agent", isLead: false, status: "idle" });
  await createAgent({ id: reviewAgent, name: "Review Agent", isLead: false, status: "idle" });
});

afterEach(() => {
  setSystemTime();
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("memory search does not rescan the tables on every call", () => {
  test("a cached fallback is dropped by the first vector write", async () => {
    const store = new SqliteMemoryStore();
    const vecUsable = store.getHealth().sqliteVec.initialized;
    // Empty memory_vec: this search caches a fallback health.
    expect(await store.search(queryEmbedding, healthAgent, { limit: 5 })).toEqual([]);
    await remember(store, healthAgent, "first-note", "manual", null, 0.9);
    const [hit] = await store.search(queryEmbedding, healthAgent, { limit: 5 });
    expect(hit?.name).toBe("first-note");
    expect(hit?.retrievalSource).toBe(vecUsable ? "vec" : "fallback");
  });

  test("search computes the health counts once per window and never counts memory_vec per query", async () => {
    const store = new SqliteMemoryStore();
    await remember(store, healthAgent, "second-note", "manual", null, 0.8);
    const scans = watchCountScans();
    try {
      for (let i = 0; i < 3; i++) {
        await store.search(queryEmbedding, healthAgent, { limit: 5 }); // vec path
        await store.search(queryEmbedding, healthAgent, { limit: 5, queryText: QUERY }); // hybrid
      }
      expect(scans.health).toBe(1);
      // The health counts hold the only memory_vec count: none per vec query.
      expect(scans.vecCount).toBeLessThanOrEqual(1);

      // A store write inside the window does not recount while the mode is vec.
      await remember(store, healthAgent, "third-note", "manual", null, 0.7);
      const names = (await store.search(queryEmbedding, healthAgent, { limit: 5 })).map(
        (c) => c.name,
      );
      expect(names).toContain("third-note");
      expect(scans.health).toBe(1);

      setSystemTime(new Date(Date.now() + SEARCH_HEALTH_TTL_MS + 1));
      await store.search(queryEmbedding, healthAgent, { limit: 5 });
      await store.search(queryEmbedding, healthAgent, { limit: 5 });
      expect(scans.health).toBe(2);

      // The health endpoint's read stays fresh on every call.
      store.getHealth();
      store.getHealth();
      expect(scans.health).toBe(4);
    } finally {
      scans.stop();
    }
  });
});

describe("a review task's recall excludes review completions in the store query", () => {
  const REVIEW_ROWS = 100;
  const LIMIT = 5;
  const kept = [
    "plain-completion",
    "manual-on-review-task",
    "orphan-completion",
    "malformed-tags-completion",
    "scalar-tag-completion",
  ];

  beforeAll(async () => {
    const store = new SqliteMemoryStore();
    // Nearest neighbours: 100 completions of other review tasks, one task each
    // so rerank()'s per-document collapse plays no part.
    const reviewTasks = [
      await insertTask("review", "[]"),
      await insertTask(null, JSON.stringify(["pr-fix-loop", "re-review"])),
      await insertTask(null, JSON.stringify(["pr-review-demo"])),
    ];
    for (let i = 0; i < REVIEW_ROWS; i++) {
      const task = i < reviewTasks.length ? reviewTasks[i] : await insertTask("review", "[]");
      await remember(
        store,
        reviewAgent,
        `review-${i}`,
        "task_completion",
        task as string,
        0.99 - i * 0.001,
      );
    }
    // Further away, and all of them rows the rule keeps.
    await remember(
      store,
      reviewAgent,
      kept[0] as string,
      "task_completion",
      await insertTask("bug", "[]"),
      0.85,
    );
    await remember(store, reviewAgent, kept[1] as string, "manual", reviewTasks[0] as string, 0.84);
    await remember(store, reviewAgent, kept[2] as string, "task_completion", randomUUID(), 0.83);
    // parseTags() reads malformed and non-array tags as no tags.
    await remember(
      store,
      reviewAgent,
      kept[3] as string,
      "task_completion",
      await insertTask(null, "{not json"),
      0.82,
    );
    await remember(
      store,
      reviewAgent,
      kept[4] as string,
      "task_completion",
      await insertTask(null, '"re-review"'),
      0.81,
    );
  });

  for (const queryText of [undefined, QUERY]) {
    test(`${queryText ? "hybrid" : "vec"}: one store.search round fills the limit with none of them`, async () => {
      const store = new SqliteMemoryStore();
      let rounds = 0;
      const realSearch = store.search.bind(store);
      store.search = (...args: Parameters<SqliteMemoryStore["search"]>) => {
        rounds++;
        return realSearch(...args);
      };
      const rows = await searchMemoryCandidates(store, queryEmbedding, reviewAgent, {
        limit: LIMIT,
        scope: "agent",
        queryText,
        excludeReviewTaskCompletions: true,
      });
      expect(rows.map((row) => row.name).sort()).toEqual([...kept].sort());
      expect(rounds).toBeLessThanOrEqual(3);
      expect(rounds).toBe(1);
    });
  }

  test("without the option the review completions still rank first", async () => {
    const store = new SqliteMemoryStore();
    const rows = await store.search(queryEmbedding, reviewAgent, { limit: LIMIT });
    expect(rows.map((row) => row.name)).toEqual([0, 1, 2, 3, 4].map((i) => `review-${i}`));
  });
});
