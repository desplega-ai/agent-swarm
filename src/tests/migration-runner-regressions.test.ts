import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { runMigrations } from "../be/migrations/runner";

const INCOMPLETE_DB_PATH = "./test-migration-incomplete.sqlite";
const FRESH_DB_PATH = "./test-migration-fresh.sqlite";
const REPAIR_DB_PATH = "./test-migration-repair.sqlite";

async function removeDbFiles(dbPath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(dbPath + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

afterEach(async () => {
  closeDb();
  await removeDbFiles(INCOMPLETE_DB_PATH);
  await removeDbFiles(FRESH_DB_PATH);
  await removeDbFiles(REPAIR_DB_PATH);
});

describe("migration regressions", () => {
  test("incomplete existing DB runs 001_initial instead of blind bootstrap", () => {
    const now = new Date().toISOString();
    const legacyDb = new Database(INCOMPLETE_DB_PATH, { create: true });
    legacyDb.run(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        isLead INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        maxTasks INTEGER DEFAULT 1,
        emptyPollCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL
      )
    `);
    legacyDb.run(
      "INSERT INTO agents (id, name, isLead, status, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), "legacy", 0, "idle", now, now],
    );
    legacyDb.close();

    const database = initDb(INCOMPLETE_DB_PATH);

    const channelsTable = database
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='channels'",
      )
      .get();
    expect(channelsTable?.name).toBe("channels");

    const generalChannel = database
      .prepare<{ id: string }, []>("SELECT id FROM channels WHERE name = 'general'")
      .get();
    expect(generalChannel?.id).toBe("00000000-0000-4000-8000-000000000001");

    const columns = database
      .prepare<{ name: string }, []>("PRAGMA table_info(agents)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("soulMd");
    expect(columns).toContain("identityMd");
    expect(columns).toContain("toolsMd");
    expect(columns).toContain("claudeMd");
    expect(columns).toContain("setupScript");
  });

  test("fresh DB drops source CHECK constraint on agent_tasks (Zod is the gate)", () => {
    // Migration 056 removes the SQL CHECK on agent_tasks.source — the Zod
    // `AgentTaskSourceSchema` in src/types.ts is now the single source of
    // truth for the allowed enum, and is enforced at the HTTP/MCP ingress.
    // Direct SQL inserts no longer fail on unknown sources by design;
    // adding a new source no longer requires a forward-only migration.
    const database = initDb(FRESH_DB_PATH);
    const now = new Date().toISOString();

    expect(() => {
      database.run(
        `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), "invalid source", "pending", "not-valid", now, now],
      );
    }).not.toThrow();

    // The requestedByUserId FK survives the table-rebuild in migration 056.
    const fkList = database
      .prepare<{ table: string; from: string; to: string }, []>(
        'SELECT "table" as "table", "from", "to" FROM pragma_foreign_key_list(\'agent_tasks\')',
      )
      .all();
    const requestedByFk = fkList.find((fk) => fk.from === "requestedByUserId");
    expect(requestedByFk?.table).toBe("users");
    expect(requestedByFk?.to).toBe("id");
  });

  test("repairs seed-as-090 history so 090_model_tiers is never skipped", () => {
    // 2026-06-10 incident: PR #722 shipped the metrics seed as migration 090
    // and production applied it; PR #719 then renumbered the seed to 091 and
    // took 090 for model tiers. The runner keys applied migrations on version,
    // so those databases skipped 090_model_tiers and crashed on the missing
    // modelTier column. repairRenumberedModelTiers() in the runner must detect
    // that history and fix it on boot.
    const SEED_NAME = "090_seed_swarm_operations_metrics";
    const SEED_CHECKSUM = "8ca4a05263b42d115b419f468bf5113caa5b7ee4363177568897513549224b01";

    // Raw Database + runMigrations directly: initDb()'s test-template fast
    // path skips the runner entirely, and the repair lives in the runner.
    const database = new Database(REPAIR_DB_PATH, { create: true });
    runMigrations(database);

    // Reconstruct the divergent history: modelTier columns absent, version 90
    // recorded as the seed migration.
    database.run("ALTER TABLE agent_tasks DROP COLUMN modelTier");
    database.run("ALTER TABLE scheduled_tasks DROP COLUMN modelTier");
    database.run("UPDATE _migrations SET name = ?, checksum = ? WHERE version = 90", [
      SEED_NAME,
      SEED_CHECKSUM,
    ]);

    // Next boot repairs the history.
    runMigrations(database);

    for (const table of ["agent_tasks", "scheduled_tasks"]) {
      const columns = database
        .prepare<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      expect(columns).toContain("modelTier");
    }

    const row = database
      .prepare<{ name: string; checksum: string }, []>(
        "SELECT name, checksum FROM _migrations WHERE version = 90",
      )
      .get();
    expect(row?.name).toBe("090_model_tiers");
    expect(row?.checksum).not.toBe(SEED_CHECKSUM);

    // The original failure mode: inserting a task with a modelTier value.
    const now = new Date().toISOString();
    expect(() => {
      database.run(
        `INSERT INTO agent_tasks (id, task, status, source, modelTier, createdAt, lastUpdatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), "boot triage", "pending", "system", "regular", now, now],
      );
    }).not.toThrow();

    // Healthy histories are untouched: booting again is a no-op.
    runMigrations(database);
    const rowAfter = database
      .prepare<{ name: string; checksum: string }, []>(
        "SELECT name, checksum FROM _migrations WHERE version = 90",
      )
      .get();
    expect(rowAfter?.name).toBe("090_model_tiers");
    expect(rowAfter?.checksum).toBe(row?.checksum);

    database.close();
  });
});
