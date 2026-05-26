import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";

const TEST_DB_PATH = "./test-migration-075.sqlite";
const MIGRATION_SQL = readFileSync(
  new URL("../be/migrations/075_kapso_number_mapping_backfill.sql", import.meta.url),
  "utf8",
);

function createDb(): Database {
  const db = new Database(TEST_DB_PATH, { create: true });
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      isLead INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastUpdatedAt TEXT NOT NULL
    );

    CREATE TABLE swarm_config (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scopeId TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      isSecret INTEGER NOT NULL DEFAULT 0,
      envPath TEXT,
      description TEXT,
      createdAt TEXT NOT NULL,
      lastUpdatedAt TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE kv_entries (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL DEFAULT 'json',
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
      PRIMARY KEY (namespace, key)
    ) WITHOUT ROWID;
  `);
  return db;
}

function seedLeadAndKapsoConfig(db: Database): void {
  db.run(
    `INSERT INTO agents (id, name, isLead, status, createdAt, lastUpdatedAt)
     VALUES ('lead-1', 'Lead', 1, 'idle', '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`,
  );
  db.run(
    `INSERT INTO swarm_config
       (id, scope, scopeId, key, value, isSecret, createdAt, lastUpdatedAt, encrypted)
     VALUES
       ('cfg-phone', 'global', NULL, 'KAPSO_PHONE_NUMBER_ID', 'pn-123', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z', 0)`,
  );
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

let db: Database;

beforeEach(async () => {
  await removeDbFiles();
  db = createDb();
});

afterEach(async () => {
  db.close();
  await removeDbFiles();
});

describe("Migration 075 — Kapso number mapping backfill", () => {
  test("creates missing Kapso number mapping from global config and lead agent", () => {
    seedLeadAndKapsoConfig(db);

    db.exec(MIGRATION_SQL);

    const row = db
      .prepare<{ value: string; value_type: string; expires_at: number | null }, []>(
        `SELECT value, value_type, expires_at
         FROM kv_entries
         WHERE namespace = 'integrations:kapso:numbers' AND key = 'pn-123'`,
      )
      .get();
    expect(row?.value_type).toBe("json");
    expect(row?.expires_at).toBeNull();

    const mapping = JSON.parse(row?.value ?? "{}") as {
      phoneNumberId?: string;
      agentId?: string;
      name?: string;
      createdAt?: string;
    };
    expect(mapping.phoneNumberId).toBe("pn-123");
    expect(mapping.agentId).toBe("lead-1");
    expect(mapping.name).toBe("Configured Kapso number");
    expect(mapping.createdAt).toMatch(/^2026-|^\d{4}-/);
  });

  test("does not overwrite an existing Kapso number mapping", () => {
    seedLeadAndKapsoConfig(db);
    db.run(
      `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
       VALUES ('integrations:kapso:numbers', 'pn-123', ?, 'json', NULL, 1, 1)`,
      [
        JSON.stringify({
          phoneNumberId: "pn-123",
          workflowId: "workflow-1",
          createdAt: "2026-05-25T00:00:00.000Z",
        }),
      ],
    );

    db.exec(MIGRATION_SQL);

    const row = db
      .prepare<{ value: string }, []>(
        `SELECT value
         FROM kv_entries
         WHERE namespace = 'integrations:kapso:numbers' AND key = 'pn-123'`,
      )
      .get();
    expect(JSON.parse(row?.value ?? "{}")).toEqual({
      phoneNumberId: "pn-123",
      workflowId: "workflow-1",
      createdAt: "2026-05-25T00:00:00.000Z",
    });
  });
});
