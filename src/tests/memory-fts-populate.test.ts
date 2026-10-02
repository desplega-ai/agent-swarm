import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, getDbClient, initDb } from "../be/db";
import {
  FTS_DELETE_EXTRA_SQL,
  FTS_MISSING_IDS_SQL,
  SqliteMemoryStore,
} from "../be/memory/providers/sqlite-store";

const TEST_DB_PATH = "./test-memory-fts-populate.sqlite";
const agentId = "aaaa0000-0000-4000-8000-000000000171";

// The pre-fix backfill. Kept here as the positive control for the plan check:
// if SQLite ever stops reporting it as CORRELATED, the assertion below would
// pass vacuously, so the control has to fail first.
const QUADRATIC_BACKFILL_SQL = `INSERT INTO memory_fts(memory_id, name, content)
  SELECT m.id, m.name, m.content
  FROM agent_memory m
  WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = m.id)`;

// EXPLAIN goes through a prepared statement that is finalized right away: the
// client's cached `db.query()` statement for an EXPLAIN stays "in progress" and
// wedges the connection's next COMMIT.
function planOf(sql: string): string[] {
  const stmt = getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return (stmt.all() as { detail: string }[]).map((row) => row.detail);
  } finally {
    stmt.finalize();
  }
}

async function count(sql: string, params: string[] = []): Promise<number> {
  return (await getDbClient().get<{ count: number }>(sql, params))?.count ?? -1;
}

describe("memory_fts boot backfill", () => {
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    await createAgent({ id: agentId, name: "FTS Populate Agent", isLead: false, status: "idle" });
    store = new SqliteMemoryStore();
    await store.whenFtsPopulated();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("diff queries are not correlated against the UNINDEXED memory_id", async () => {
    // Positive control: the old anti-join scans memory_fts once per memory.
    expect(planOf(QUADRATIC_BACKFILL_SQL).join(" | ")).toContain("CORRELATED");

    for (const sql of [FTS_MISSING_IDS_SQL, FTS_DELETE_EXTRA_SQL]) {
      const plan = planOf(sql).join(" | ");
      expect(plan).not.toContain("CORRELATED");
      // Exactly one pass over memory_fts per statement.
      expect(plan.match(/SCAN memory_fts/g)?.length).toBe(1);
    }
  });

  test("a new store backfills missing rows across batches and drops orphans", async () => {
    const total = 1050; // crosses two 500-row batch boundaries
    const seed = await store.store({
      agentId,
      scope: "agent",
      name: "fts backfill 0",
      content: "backfill-token-0",
      source: "manual",
    });
    // Clone the seed row in one statement: 1,050 store() calls outrun the
    // default test timeout, and the backfill only reads id/name/content.
    const columns = (
      await getDbClient().query<{ name: string }>("PRAGMA table_info(agent_memory)")
    ).map((col) => col.name);
    const projection = columns
      .map((col) => {
        if (col === "id") return "'clone-' || n.i";
        if (col === "name") return "'fts backfill ' || n.i";
        if (col === "content") return "'backfill-token-' || n.i";
        if (col === "key") return "'fts-backfill-' || n.i";
        return `s."${col}"`;
      })
      .join(", ");
    await getDbClient().run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO agent_memory(${columns.map((col) => `"${col}"`).join(", ")})
       SELECT ${projection} FROM n, agent_memory s WHERE s.id = ?`,
      [total - 1, seed.id],
    );
    const ids = [seed.id];
    expect(await count("SELECT COUNT(*) AS count FROM agent_memory")).toBe(total);
    // Only the seed went through store(), so only it is indexed so far.
    expect(await count("SELECT COUNT(*) AS count FROM memory_fts")).toBe(1);
    await getDbClient().run(
      "INSERT INTO memory_fts(memory_id, name, content) SELECT id, name, content FROM agent_memory WHERE id != ?",
      [seed.id],
    );
    expect(await count("SELECT COUNT(*) AS count FROM memory_fts")).toBe(total);

    // Simulate an index that lost most of its rows and gained an orphan.
    await getDbClient().run("DELETE FROM memory_fts WHERE memory_id != ?", [ids[0] as string]);
    await getDbClient().run(
      "INSERT INTO memory_fts(memory_id, name, content) VALUES ('orphan-id', 'orphan', 'orphan')",
    );

    const rebuilt = new SqliteMemoryStore();
    await rebuilt.whenFtsPopulated();

    expect(await count("SELECT COUNT(*) AS count FROM memory_fts")).toBe(total);
    expect(await count("SELECT COUNT(DISTINCT memory_id) AS count FROM memory_fts")).toBe(total);
    expect(
      await count("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_id = 'orphan-id'"),
    ).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH ?", [
        '"backfill-token-1049"',
      ]),
    ).toBe(1);
  });

  test("a steady-state boot inserts nothing", async () => {
    const before = await count("SELECT COUNT(*) AS count FROM memory_fts");
    const again = new SqliteMemoryStore();
    await again.whenFtsPopulated();
    expect(await count("SELECT COUNT(*) AS count FROM memory_fts")).toBe(before);
  });
});
