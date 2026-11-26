import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPostgresClient, type PostgresClient, readPostgresStats } from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

/** The `pg_stat_*` read behind the API's Postgres gauges (`agentswarm.pg.*`). */

let scratch: ScratchDatabase;
let client: PostgresClient;
let other: InstanceType<typeof Bun.SQL>;

beforeAll(async () => {
  scratch = await createScratchDatabase("pgstats");
  client = createPostgresClient(scratch.url, { max: 2 });
  other = new Bun.SQL({ url: scratch.url, max: 1 });
  for (const name of ["t_a", "t_b", "t_c", "t_d", "t_e"]) {
    await client.run(`CREATE TABLE ${name} (id int)`);
    await client.run(`INSERT INTO ${name} SELECT generate_series(1, 20)`);
  }
});

afterAll(async () => {
  await other.close();
  await client.close();
  await scratch.drop();
});

describe("readPostgresStats", () => {
  test("reads server, database and table stats with no pg_stat_statements", async () => {
    await client.run(`DROP EXTENSION IF EXISTS pg_stat_statements`);
    const stats = await readPostgresStats(client, { topTables: 2 });

    expect(stats.maxConnections).toBeGreaterThan(0);
    expect(stats.databaseSizeBytes).toBeGreaterThan(0);
    expect(stats.commits).toBeGreaterThan(0);
    expect(stats.blocksHit + stats.blocksRead).toBeGreaterThan(0);
    for (const n of [stats.rollbacks, stats.deadlocks, stats.tempBytes]) {
      expect(typeof n).toBe("number");
    }
    // Our own connection is a client connection in a transaction.
    const total = stats.connectionsByState.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(stats.connectionsByState.every((c) => typeof c.state === "string")).toBe(true);
    // Two rankings of two tables each: never more than four tables.
    expect(stats.tables.length).toBeGreaterThan(0);
    expect(stats.tables.length).toBeLessThanOrEqual(4);
    for (const t of stats.tables) {
      expect(t.table).toMatch(/^t_[a-e]$/);
      expect(typeof t.seqScans).toBe("number");
    }
    expect(stats.statements).toBeNull();
  });

  test("SET LOCAL keeps the statement timeout inside the poll", async () => {
    await readPostgresStats(client, { statementTimeoutMs: 1234 });
    const row = await client.get<{ t: string }>(`SELECT current_setting('statement_timeout') AS t`);
    expect(row?.t).not.toBe("1234ms");
  });

  test("reports the age of another connection's running query", async () => {
    // Bun.SQL queries are lazy: execute() sends it now.
    const sleeping = other.unsafe("SELECT pg_sleep(1.5)").execute();
    try {
      await Bun.sleep(600);
      const stats = await readPostgresStats(client);
      expect(stats.longestQuerySeconds).toBeGreaterThan(0.3);
      expect(stats.longestTransactionSeconds).toBeGreaterThan(0.3);
      expect(stats.connectionsByState.find((c) => c.state === "active")?.count).toBeGreaterThan(0);
    } finally {
      await sleeping;
    }
  });

  test("pg_stat_statements: totals when loaded, null (and the rest intact) when only created", async () => {
    await client.run(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    try {
      const preload = await client.get<{ libs: string }>(
        `SELECT current_setting('shared_preload_libraries') AS libs`,
      );
      const loaded = (preload?.libs ?? "").includes("pg_stat_statements");
      const stats = await readPostgresStats(client);
      if (loaded) {
        expect(stats.statements?.calls).toBeGreaterThan(0);
        expect(typeof stats.statements?.totalExecMs).toBe("number");
      } else {
        // The view errors without the preload: the savepoint keeps the poll alive.
        expect(stats.statements).toBeNull();
      }
      expect(stats.maxConnections).toBeGreaterThan(0);
      expect(stats.tables.length).toBeGreaterThan(0);
    } finally {
      await client.run(`DROP EXTENSION IF EXISTS pg_stat_statements`);
    }
  });
});
