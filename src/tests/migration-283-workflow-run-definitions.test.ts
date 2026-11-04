import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";

const TEST_DB_PATH = "./test-migration-283-workflow-run-definitions.sqlite";
const MIGRATION = "src/be/migrations/283_workflow_run_definitions.sql";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

test("migration 283 applies on a fresh database", async () => {
  const client = getDbClient();
  const columns = await client.query<{ name: string; notnull: number }>(
    "SELECT name, \"notnull\" FROM pragma_table_info('workflow_run_definitions') ORDER BY cid",
  );
  expect(columns).toEqual([
    { name: "hash", notnull: 0 },
    { name: "snapshot", notnull: 1 },
    { name: "createdAt", notnull: 1 },
  ]);
  const runColumn = await client.get<{ name: string }>(
    "SELECT name FROM pragma_table_info('workflow_runs') WHERE name = 'definitionHash'",
  );
  expect(runColumn?.name).toBe("definitionHash");
  const index = await client.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_runs_definitionHash'",
  );
  expect(index?.name).toBe("idx_workflow_runs_definitionHash");
});

test("migration 283 leaves existing runs unpinned and rejects an unknown hash", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflowId TEXT, status TEXT)");
    db.exec(
      "INSERT INTO workflow_runs (id, workflowId, status) VALUES ('old-done', 'wf', 'completed'), ('old-waiting', 'wf', 'waiting')",
    );

    db.exec(await Bun.file(MIGRATION).text());

    expect(db.prepare("SELECT id, definitionHash FROM workflow_runs ORDER BY id").all()).toEqual([
      { id: "old-done", definitionHash: null },
      { id: "old-waiting", definitionHash: null },
    ]);
    db.exec(
      "INSERT INTO workflow_run_definitions (hash, snapshot, createdAt) VALUES ('h1', '{}', '2026-11-04T00:00:00.000Z')",
    );
    db.exec(
      "INSERT INTO workflow_runs (id, workflowId, status, definitionHash) VALUES ('new', 'wf', 'running', 'h1')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO workflow_runs (id, workflowId, status, definitionHash) VALUES ('bad', 'wf', 'running', 'missing')",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});
