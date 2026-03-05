import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";

const INCOMPLETE_DB_PATH = "./test-migration-incomplete.sqlite";
const FRESH_DB_PATH = "./test-migration-fresh.sqlite";

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

  test("fresh DB preserves source CHECK constraint on agent_tasks", () => {
    const database = initDb(FRESH_DB_PATH);
    const now = new Date().toISOString();

    expect(() => {
      database.run(
        `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), "invalid source", "pending", "not-valid", now, now],
      );
    }).toThrow();
  });
});
