import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, getDbClient, initDb } from "../be/db";
import { SEARCH_HEALTH_TTL_MS, SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { searchMemoryCandidates } from "../be/memory/search-candidates";
import {
  __resetMemorySearchReaderForTests,
  memorySearchReader,
  memorySearchReaderStats,
} from "../be/memory/search-reader";
import type { AgentMemory } from "../types";

// POST /api/memory/search stalled the API event loop for 10 to 30 s. Two causes,
// both in the store's search path:
//   1. search() ran the health counts (8 sync COUNT(*) scans) on every call,
//      plus one COUNT(*) FROM memory_vec per vec query. Once per window on the
//      event loop was still a ~0.8 s stall every minute at 63k memories, so the
//      counts now run on a read worker and an expired result is served while
//      one refresh runs.
//   2. a review task's recall dropped review completions after the fetch, so
//      a window full of them widened the fetch round after round.
// Everything here is real: the SQLite store and its vec, FTS and hybrid paths.

const TEST_DB_PATH = "./test-memory-search-stall.sqlite";
// A real file, not the in-memory migration template: search reads and the
// health counts then run on read workers, against their own WAL snapshots.
const globals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedSearchStallTemplate?: Uint8Array;
};
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
): Promise<string> {
  const row = await store.store({
    agentId,
    scope: "agent",
    name,
    content: `${QUERY} ${name}`,
    source,
    sourceTaskId: sourceTaskId ?? undefined,
  });
  await store.updateEmbedding(row.id, mix(cos, 4), "test");
  return row.id;
}

/**
 * Count the statements the health counts and the vec count run: `health` and
 * `vecCount` on the raw main-thread handle, `offLoop` for the one-statement
 * count the search path sends to a read worker. An off-loop count whose index
 * is in `hold` reads the DB, resolves `counted(i)` and waits for `release(i)`.
 */
function watchCountScans(): {
  health: number;
  vecCount: number;
  offLoop: number;
  hold: Set<number>;
  counted: (i: number) => Promise<void>;
  release: (i: number) => void;
  stop: () => void;
} {
  const db = getDb();
  const realPrepare = db.prepare;
  const realGet = memorySearchReader.get;
  const gates: { counted: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }[] = [];
  const gate = (i: number) => {
    gates[i] ??= { counted: Promise.withResolvers(), release: Promise.withResolvers() };
    return gates[i];
  };
  const seen = {
    health: 0,
    vecCount: 0,
    offLoop: 0,
    hold: new Set<number>(),
    counted: (i: number) => gate(i).counted.promise,
    release: (i: number) => gate(i).release.resolve(),
    stop: () => {
      db.prepare = realPrepare;
      memorySearchReader.get = realGet;
      for (const held of gates) held?.release.resolve();
    },
  };
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    // getHealthCounts() runs this statement exactly once per call.
    if (sql === "SELECT COUNT(*) as count FROM agent_memory") seen.health++;
    if (sql === "SELECT COUNT(*) as count FROM memory_vec") seen.vecCount++;
    return (realPrepare as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.prepare;
  memorySearchReader.get = (async (sql: string, params?: never) => {
    if (!sql.includes("AS extraInVec")) return realGet(sql, params);
    const i = seen.offLoop++;
    const row = await realGet(sql, params);
    if (seen.hold.has(i)) {
      gate(i).counted.resolve();
      await gate(i).release.promise;
    }
    return row;
  }) as typeof memorySearchReader.get;
  return seen;
}

/** Wait for the `i`th off-loop count to read the DB, or give up after 1 s (no such count). */
async function countedWithin(scans: ReturnType<typeof watchCountScans>, i: number): Promise<void> {
  await Promise.race([scans.counted(i), Bun.sleep(1000)]);
}

/** Make every memory_vec INSERT throw until the returned restore runs. */
function failVecInserts(): () => void {
  const db = getDb();
  const realQuery = db.query;
  db.query = ((sql: string, ...rest: unknown[]) => {
    if (sql.startsWith("INSERT INTO memory_vec")) throw new Error("injected vec insert failure");
    return (realQuery as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.query;
  return () => {
    db.query = realQuery;
  };
}

/** Wait for the background health refresh a search started. */
async function settleHealthRefresh(store: SqliteMemoryStore): Promise<void> {
  await (store as unknown as { searchHealthRefresh: { promise: Promise<unknown> } | null })
    .searchHealthRefresh?.promise;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  globals.__savedSearchStallTemplate = globals.__testMigrationTemplate;
  globals.__testMigrationTemplate = undefined;
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: healthAgent, name: "Health Agent", isLead: false, status: "idle" });
  await createAgent({ id: reviewAgent, name: "Review Agent", isLead: false, status: "idle" });
});

afterEach(() => {
  setSystemTime();
});

afterAll(async () => {
  await __resetMemorySearchReaderForTests();
  closeDb();
  globals.__testMigrationTemplate = globals.__savedSearchStallTemplate;
  globals.__savedSearchStallTemplate = undefined;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("memory search does not rescan the tables on every call", () => {
  test("a cached or in-flight fallback is dropped by the first vector write", async () => {
    const store = new SqliteMemoryStore();
    const vecUsable = store.getHealth().sqliteVec.initialized;
    const expectedSource = vecUsable ? "vec" : "fallback";
    const scans = watchCountScans();
    scans.hold = new Set([0, 1]);
    try {
      // Empty memory_vec: this search counts a fallback health, held after its read.
      const first = store.search(queryEmbedding, healthAgent, { limit: 5 });
      await scans.counted(0);
      await remember(store, healthAgent, "first-note", "manual", null, 0.9);
      // The write made that count obsolete: a new search recounts, not joins it.
      const afterWrite = store.search(queryEmbedding, healthAgent, { limit: 5 });
      await countedWithin(scans, 1);
      expect(scans.offLoop).toBe(2);
      // The obsolete count settles without clearing the newer refresh, so a
      // third search joins that one instead of starting another.
      scans.release(0);
      await Bun.sleep(10);
      const joined = store.search(queryEmbedding, healthAgent, { limit: 5 });
      expect(scans.offLoop).toBe(2);
      scans.release(1);
      // The search already waiting on the obsolete count retries it too.
      for (const search of [first, afterWrite, joined]) {
        const [hit] = await search;
        expect(hit?.name).toBe("first-note");
        expect(hit?.retrievalSource).toBe(expectedSource);
      }
      expect(scans.offLoop).toBe(2);
    } finally {
      scans.stop();
    }
  });

  test("search computes the health counts off the event loop, once per window, and never counts memory_vec per query", async () => {
    const store = new SqliteMemoryStore();
    const vecUsable = store.getHealth().sqliteVec.initialized;
    await remember(store, healthAgent, "second-note", "manual", null, 0.8);
    const scans = watchCountScans();
    try {
      for (let i = 0; i < 3; i++) {
        await store.search(queryEmbedding, healthAgent, { limit: 5 }); // vec path
        await store.search(queryEmbedding, healthAgent, { limit: 5, queryText: QUERY }); // hybrid
      }
      expect(scans.offLoop).toBe(1);
      // Nothing scanned on the main-thread handle: not the counts, not memory_vec.
      expect(scans.health).toBe(0);
      expect(scans.vecCount).toBe(0);

      // A store write inside the window does not recount while the mode is vec.
      await remember(store, healthAgent, "third-note", "manual", null, 0.7);
      const names = (await store.search(queryEmbedding, healthAgent, { limit: 5 })).map(
        (c) => c.name,
      );
      expect(names).toContain("third-note");
      expect(scans.offLoop).toBe(1);

      // Past the window the stale "vec" result is served and one refresh runs.
      setSystemTime(new Date(Date.now() + SEARCH_HEALTH_TTL_MS + 1));
      await store.search(queryEmbedding, healthAgent, { limit: 5 });
      await store.search(queryEmbedding, healthAgent, { limit: 5 });
      await settleHealthRefresh(store);
      expect(scans.offLoop).toBe(2);
      expect(scans.health).toBe(0);

      // The health endpoint's read stays fresh on every call, and the worker's
      // single-statement counts equal it.
      const fresh = store.getHealth();
      store.getHealth();
      expect(scans.health).toBe(2);
      const offLoop = await (
        store as unknown as { getHealthCountsOffLoop(): Promise<unknown> }
      ).getHealthCountsOffLoop();
      expect(offLoop).toEqual(fresh.counts);
      if (!vecUsable) return; // no vec0: every result is a fallback

      // A vec update that fails while an expired "vec" recounts: that count
      // read the DB before the failure, so a search must not use it.
      const noteId = await remember(store, healthAgent, "fourth-note", "manual", null, 0.6);
      const fourth = async () =>
        (await store.search(queryEmbedding, healthAgent, { limit: 5 })).find(
          (c) => c.name === "fourth-note",
        );
      setSystemTime(new Date(Date.now() + SEARCH_HEALTH_TTL_MS + 1));
      let k = scans.offLoop;
      scans.hold = new Set([k, k + 1]);
      await store.search(queryEmbedding, healthAgent, { limit: 5 }); // stale "vec", count k held
      await scans.counted(k);
      let restoreInserts = failVecInserts();
      try {
        await store.updateEmbedding(noteId, mix(0.6, 4), "test");
      } finally {
        restoreInserts();
      }
      const afterFailure = fourth();
      scans.release(k);
      await countedWithin(scans, k + 1);
      scans.release(k + 1);
      expect((await afterFailure)?.retrievalSource).toBe("fallback");

      // Repaired, then failed again with a search counting inside the failing
      // transaction, before its COMMIT: the worker reads the snapshot that still
      // has the vec row. The drop after COMMIT keeps that "vec" count out.
      scans.hold = new Set();
      await store.updateEmbedding(noteId, mix(0.6, 4), "test");
      expect((await fourth())?.retrievalSource).toBe("vec");
      expect(await memorySearchReaderStats()).not.toBeNull();
      k = scans.offLoop;
      scans.hold = new Set([k]);
      const client = getDbClient();
      const realTransaction = client.transaction;
      const windowOpen = Promise.withResolvers<void>();
      // Chained here, outside any transaction, so the search runs outside it too.
      const windowSearch = windowOpen.promise.then(() =>
        store.search(queryEmbedding, healthAgent, { limit: 5 }),
      );
      client.transaction = ((fn, opts) =>
        realTransaction.call(
          client,
          async (tx) => {
            const result = await fn(tx);
            windowOpen.resolve();
            await countedWithin(scans, k);
            return result;
          },
          opts,
        )) as typeof client.transaction;
      restoreInserts = failVecInserts();
      try {
        await store.updateEmbedding(noteId, mix(0.6, 4), "test");
      } finally {
        restoreInserts();
        client.transaction = realTransaction;
      }
      expect(scans.offLoop).toBe(k + 1);
      scans.release(k);
      await windowSearch;
      expect((await fourth())?.retrievalSource).toBe("fallback");
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

// The two remaining full scans on hot memory paths, measured at 57k memories:
// the health count's agent_memory -> memory_vec anti-join (about 1.1 s of the
// 1.3 s getHealth()) and store()'s DELETE FROM memory_fts per stored chunk
// (memory_id is UNINDEXED, so each delete reads the whole index).
describe("health counts and the FTS sync avoid full scans", () => {
  const scanAgent = randomUUID();
  const FTS_DELETE_SQL = "DELETE FROM memory_fts WHERE memory_id = ?";

  beforeAll(async () => {
    await createAgent({ id: scanAgent, name: "Scan Agent", isLead: false, status: "idle" });
  });

  function watchFtsDeletes(): { deletes: number; stop: () => void } {
    const db = getDb();
    const realQuery = db.query;
    const seen = {
      deletes: 0,
      stop: () => {
        db.query = realQuery;
      },
    };
    db.query = ((sql: string, ...rest: unknown[]) => {
      if (sql === FTS_DELETE_SQL) seen.deletes++;
      return (realQuery as (...args: unknown[]) => unknown).call(db, sql, ...rest);
    }) as typeof db.query;
    return seen;
  }

  async function ftsRowCount(memoryId: string): Promise<number> {
    const row = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id = ?",
      [memoryId],
    );
    return row?.n ?? 0;
  }

  test("missingFromVec equals the agent_memory anti-join it replaced", async () => {
    const store = new SqliteMemoryStore();
    if (!store.getHealth().sqliteVec.initialized) return; // no vec0: the count is validEmbedding
    for (let i = 0; i < 3; i++) await remember(store, scanAgent, `vec-${i}`, "manual", null, 0.5);
    const dropped = await store.store({
      agentId: scanAgent,
      scope: "agent",
      name: "vec-dropped",
      content: "vec-dropped",
      source: "manual",
    });
    await store.updateEmbedding(dropped.id, mix(0.5, 5), "test");
    await getDbClient().run("DELETE FROM memory_vec WHERE memory_id = ?", [dropped.id]);
    // Wrong dimensions: counted in neither side of the difference.
    const invalid = await store.store({
      agentId: scanAgent,
      scope: "agent",
      name: "vec-invalid",
      content: "vec-invalid",
      source: "manual",
    });
    await store.updateEmbedding(invalid.id, new Float32Array(7), "test");
    // No embedding at all: counted in neither side either.
    await store.store({
      agentId: scanAgent,
      scope: "agent",
      name: "vec-none",
      content: "vec-none",
      source: "manual",
    });
    // A vec row with no memory behind it must not reduce the count.
    const orphanId = randomUUID();
    await getDbClient().run("INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)", [
      orphanId,
      new Uint8Array(mix(0.5, 6).buffer),
    ]);

    const oracle = getDb()
      .prepare<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM agent_memory m
         LEFT JOIN memory_vec v ON v.memory_id = m.id
         WHERE m.embedding IS NOT NULL AND length(m.embedding) = ${512 * 4}
           AND v.memory_id IS NULL`,
      )
      .get()?.n;
    try {
      expect(oracle).toBeGreaterThanOrEqual(1);
      const counts = store.getHealth().counts;
      expect(counts.extraInVec).toBeGreaterThanOrEqual(1);
      expect(counts.missingFromVec).toBe(oracle as number);
    } finally {
      await getDbClient().run("DELETE FROM memory_vec WHERE memory_id = ?", [orphanId]);
    }
  });

  test("store() runs no memory_fts delete, even while a backfill runs", async () => {
    const store = new SqliteMemoryStore(); // starts a backfill
    const watch = watchFtsDeletes();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await store.store({
          agentId: scanAgent,
          scope: "agent",
          name: `chunk-${i}`,
          content: `fts sync probe chunk ${i}`,
          source: "task_completion",
        });
        ids.push(row.id);
      }
      expect(watch.deletes).toBe(0);
      for (const id of ids) expect(await ftsRowCount(id)).toBe(1);

      // An edit rewrites an existing id: it still deletes before it inserts.
      await store.edit({
        id: ids[0],
        mode: "replace",
        content: "fts sync probe edited",
        intent: "test",
      });
      expect(watch.deletes).toBe(1);
      expect(await ftsRowCount(ids[0] as string)).toBe(1);
    } finally {
      watch.stop();
    }
  });

  test("a store() racing the boot backfill leaves one memory_fts row", async () => {
    const store = new SqliteMemoryStore(); // starts a backfill
    const row = await store.store({
      agentId: scanAgent,
      scope: "agent",
      name: "racing",
      content: "fts sync probe racing",
      source: "manual",
    });
    await store.whenFtsPopulated();
    expect(await ftsRowCount(row.id)).toBe(1);
  });

  test("a backfill that finishes between store()'s commit and return leaves one memory_fts row", async () => {
    const store = new SqliteMemoryStore();
    await store.whenFtsPopulated();
    // Pause store() after its outermost transaction commits, before it returns.
    const client = getDbClient();
    const realTransaction = client.transaction;
    let committed!: () => void;
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    client.transaction = (async (fn, opts) => {
      if (!armed) return realTransaction.call(client, fn, opts);
      armed = false;
      const result = await realTransaction.call(client, fn, opts);
      committed();
      await gate;
      return result;
    }) as typeof client.transaction;
    try {
      const storing = store.store({
        agentId: scanAgent,
        scope: "agent",
        name: "paused",
        content: "fts sync probe paused",
        source: "manual",
      });
      await commit;
      // Another instance's backfill sees the committed row and runs to completion.
      await new SqliteMemoryStore().whenFtsPopulated();
      release();
      const row = await storing;
      expect(await ftsRowCount(row.id)).toBe(1);
    } finally {
      client.transaction = realTransaction;
    }
  });
});
