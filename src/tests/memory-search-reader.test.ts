import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { attachDemotionEvidence } from "../be/memory/demotion-evidence";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { searchMemoryCandidates } from "../be/memory/search-candidates";
import {
  __resetMemorySearchReaderForTests,
  memorySearchReader,
  memorySearchReaderStats,
  SEARCH_READ_WORKERS,
} from "../be/memory/search-reader";

// Memory search reads run in worker threads with their own read-only
// connection, so a slow vec/bm25 statement no longer freezes the API loop.
// The in-memory test template cannot be opened from a worker, so this file
// swaps it for a real WAL file, as db-query.test.ts does.

const TEST_DB_PATH = "./test-memory-search-reader.sqlite";
const agentId = randomUUID();
const otherAgent = randomUUID();
const WORDS = ["deploy", "sqlite", "worker", "review", "billing", "slack", "migration", "vector"];
const globals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedSearchReaderTemplate?: Uint8Array;
};

/** Deterministic unit vector per seed. */
function vector(seed: number): Float32Array {
  const embedding = new Float32Array(512);
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) {
    const value = Math.sin(seed * 12.9898 + i * 78.233);
    embedding[i] = value;
    norm += value * value;
  }
  for (let i = 0; i < embedding.length; i++) embedding[i]! /= Math.sqrt(norm);
  return embedding;
}

async function removeDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${TEST_DB_PATH}${suffix}`).delete();
    } catch {}
  }
}

/** Every search path the store has, plus the HTTP route's candidate fetch and evidence lookup. */
async function runSearches(store: SqliteMemoryStore) {
  const query = vector(3);
  const wrongDimension = new Float32Array(8);
  const candidates = await searchMemoryCandidates(store, query, agentId, {
    limit: 10,
    queryText: "deploy worker",
  });
  return {
    vec: await store.search(query, agentId, { limit: 10 }),
    hybrid: await store.search(query, agentId, { limit: 10, queryText: "sqlite review" }),
    fts: await store.search(wrongDimension, agentId, { limit: 10, queryText: "billing slack" }),
    swarmOnly: await store.search(query, agentId, { limit: 10, scope: "swarm" }),
    keyPrefix: await store.search(query, agentId, { limit: 10, keyPrefix: "/notes/a" }),
    exhaustive: await store.search(query, agentId, { limit: 10, exhaustive: true }),
    lead: await store.search(query, agentId, { limit: 10, isLead: true, queryText: "vector" }),
    route: await attachDemotionEvidence(candidates),
  };
}

const SLOW_SQL =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c";
const SLOW_ROWS = 3_000_000;

/** Longest gap between ticks of a 5 ms timer while `run` is pending. */
async function maxTimerGap(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  try {
    await run();
    const now = performance.now();
    return Math.max(maxGap, now - last);
  } finally {
    clearInterval(timer);
  }
}

beforeAll(async () => {
  globals.__savedSearchReaderTemplate = globals.__testMigrationTemplate;
  globals.__testMigrationTemplate = undefined;
  closeDb();
  await removeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: agentId, name: "Reader Agent", isLead: false, status: "idle" });
  await createAgent({ id: otherAgent, name: "Other Agent", isLead: false, status: "idle" });

  const store = new SqliteMemoryStore();
  for (let i = 0; i < 80; i++) {
    const row = await store.store({
      agentId: i % 3 === 0 ? otherAgent : agentId,
      scope: i % 4 === 0 ? "swarm" : "agent",
      name: `note-${i}`,
      key: `/notes/${i % 2 === 0 ? "a" : "b"}/${i}`,
      content: `${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} note ${i}`,
      source: i % 5 === 0 ? "task_completion" : "manual",
    });
    await store.updateEmbedding(row.id, vector(i), "test");
    if (i % 7 === 0) {
      // Net-negative posterior with rating rows, so the evidence lookup returns data.
      await getDbClient().run("UPDATE agent_memory SET alpha = 1, beta = 4 WHERE id = ?", [row.id]);
      await getDbClient().run(
        `INSERT INTO memory_rating (id, memoryId, source, signal, weight, createdAt)
         VALUES (?, ?, 'llm', -1, 1, datetime('now'))`,
        [randomUUID(), row.id],
      );
    }
  }
});

afterEach(async () => {
  setSystemTime();
  await __resetMemorySearchReaderForTests();
});

afterAll(async () => {
  await __resetMemorySearchReaderForTests();
  closeDb();
  globals.__testMigrationTemplate = globals.__savedSearchReaderTemplate;
  globals.__savedSearchReaderTemplate = undefined;
  await removeDb();
});

describe("memory search reads in worker threads", () => {
  test("every search path returns the same results from the workers as in-process", async () => {
    const store = new SqliteMemoryStore();
    // FTS scores apply recency decay against the clock; hold it still across both runs.
    setSystemTime(new Date());
    await __resetMemorySearchReaderForTests({ inProcess: true });
    const inProcess = await runSearches(store);
    expect(await memorySearchReaderStats()).toBeNull();

    await __resetMemorySearchReaderForTests();
    const fromWorkers = await runSearches(store);
    // Positive control: the workers served these reads.
    expect(await memorySearchReaderStats()).toEqual({
      workers: SEARCH_READ_WORKERS,
      busy: 0,
      queued: 0,
    });

    // Non-empty on every path, so equality is not two empty lists.
    for (const results of Object.values(inProcess)) expect(results.length).toBeGreaterThan(0);
    expect(inProcess.route.some((c) => c.demotionEvidence)).toBe(true);
    expect(fromWorkers).toEqual(inProcess);
  });

  test(
    "the event loop keeps running while a worker read runs; in-process it freezes",
    async () => {
      const params = [SLOW_ROWS];
      await __resetMemorySearchReaderForTests({ inProcess: true });
      const started = performance.now();
      const frozen = await maxTimerGap(() => memorySearchReader.get(SLOW_SQL, params));
      const statementMs = performance.now() - started;
      // Negative control: the in-process read blocks the timer for the whole statement.
      expect(statementMs).toBeGreaterThan(150);
      expect(frozen).toBeGreaterThan(statementMs * 0.8);

      await __resetMemorySearchReaderForTests();
      await memorySearchReader.get("SELECT 1"); // start the pool outside the measurement
      let result: unknown;
      const gap = await maxTimerGap(async () => {
        result = await memorySearchReader.get(SLOW_SQL, params);
      });
      expect(result).toEqual({ n: SLOW_ROWS });
      expect(gap).toBeLessThan(Math.min(100, statementMs / 2));
      // Wall-clock timer gaps: a loaded CI host can stretch one tick past the bound.
    },
    { retry: 2 },
  );

  test("a burst of reads runs at most SEARCH_READ_WORKERS at once and the rest queue", async () => {
    await memorySearchReader.get("SELECT 1");
    const burst = Array.from({ length: 5 }, () =>
      memorySearchReader.get<{ n: number }>(SLOW_SQL, [SLOW_ROWS]),
    );
    expect(await memorySearchReaderStats()).toEqual({
      workers: SEARCH_READ_WORKERS,
      busy: SEARCH_READ_WORKERS,
      queued: 5 - SEARCH_READ_WORKERS,
    });
    expect(await Promise.all(burst)).toEqual(Array(5).fill({ n: SLOW_ROWS }));
    expect(await memorySearchReaderStats()).toEqual({
      workers: SEARCH_READ_WORKERS,
      busy: 0,
      queued: 0,
    });
  });

  test("a SQL error from a worker read rejects with the SQLite message", async () => {
    await expect(memorySearchReader.query("SELECT * FROM no_such_table")).rejects.toThrow(
      "no such table: no_such_table",
    );
    // The pool survives a statement error.
    expect(await memorySearchReader.get("SELECT 2 AS n")).toEqual({ n: 2 });
  });

  test("a read inside a transaction stays on the main connection and sees its writes", async () => {
    const id = randomUUID();
    const seen = await getDbClient()
      .transaction(async (tx) => {
        await tx.run(
          `INSERT INTO memory_rating (id, memoryId, source, signal, weight, createdAt)
         VALUES (?, 'uncommitted', 'llm', 1, 1, datetime('now'))`,
          [id],
        );
        const row = await memorySearchReader.get("SELECT id FROM memory_rating WHERE id = ?", [id]);
        throw Object.assign(new Error("rollback"), { row });
      })
      .catch((err: Error & { row?: unknown }) => err.row);
    expect(seen).toEqual({ id });
    expect(await memorySearchReaderStats()).toBeNull();
  });

  test("workers that fail to start leave reads in-process, with a log line", async () => {
    const RealWorker = globalThis.Worker;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.Worker = class {
      constructor() {
        throw new Error("worker entry missing");
      }
    } as unknown as typeof Worker;
    try {
      const store = new SqliteMemoryStore();
      const results = await store.search(vector(3), agentId, { limit: 5, queryText: "deploy" });
      expect(results.length).toBeGreaterThan(0);
      expect(await memorySearchReaderStats()).toBeNull();
      expect(warn.mock.calls.map((args) => String(args[0]))).toContain(
        "[memory-search] read workers failed to start (worker entry missing); reads run in-process",
      );
    } finally {
      globalThis.Worker = RealWorker;
      warn.mockRestore();
    }
  });
});
