import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, getDbClient, initDb } from "../be/db";
import { purgeStaleSearchRetrievals, startMemoryGc, stopMemoryGc } from "../http/memory";

const TEST_DB_PATH = "./test-memory-retrieval-purge.sqlite";
const DAY = 24 * 60 * 60 * 1000;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

async function insertRetrieval(id: string, eventType: string, ageDays: number): Promise<void> {
  await getDbClient().run(
    `INSERT INTO memory_retrieval (id, agentId, memoryId, retrievedAt, eventType)
     VALUES (?, 'agent-1', 'memory-1', ?, ?)`,
    [id, new Date(Date.now() - ageDays * DAY).toISOString(), eventType],
  );
}

describe("purgeStaleSearchRetrievals", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  test("deletes stale search rows in batches and keeps fresh and get rows", async () => {
    for (let i = 0; i < 5; i++) await insertRetrieval(`stale-search-${i}`, "search", 120);
    await insertRetrieval("fresh-search", "search", 10);
    await insertRetrieval("stale-get", "get", 120);

    const run = spyOn(getDbClient(), "run");
    let purged: number;
    let calls: (typeof run.mock.calls)[number][];
    try {
      purged = await purgeStaleSearchRetrievals(2);
      calls = [...run.mock.calls];
    } finally {
      run.mockRestore();
    }
    expect(purged).toBe(5);
    // Batches of 2: 2 + 2 + 1, and the short batch ends the loop.
    expect(calls).toHaveLength(3);

    const left = await getDbClient().query<{ id: string }>(
      "SELECT id FROM memory_retrieval ORDER BY id",
    );
    expect(left.map((row) => row.id)).toEqual(["fresh-search", "stale-get"]);

    // Without sqlite_stat1 the plan must stay on the retrievedAt range, not
    // read every search row through the eventType index.
    const [sql, params] = calls[0]!;
    const plan = getDb()
      .query<{ detail: string }, any[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...((params ?? []) as any[]))
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("USING INDEX idx_memret_retrieved_at (retrievedAt<?)");
    expect(plan).not.toContain("idx_memret_event_type");
  });
});

describe("startMemoryGc", () => {
  test("defers the first purge off the boot path", async () => {
    const timeout = spyOn(globalThis, "setTimeout");
    try {
      await startMemoryGc(60 * 60 * 1000, 120_000);
      expect(timeout.mock.calls.some(([, ms]) => ms === 120_000)).toBe(true);
    } finally {
      stopMemoryGc();
      timeout.mockRestore();
    }
  });
});
