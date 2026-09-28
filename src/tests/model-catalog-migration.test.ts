import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

const DB_PATH = "./test-model-catalog-migration.sqlite";

async function removeDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(DB_PATH + suffix).delete();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

afterEach(removeDb);

function columnNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get(table) !== null
  );
}

describe("migration 172 model catalog, tier resolution and harness support", () => {
  test("upgrades a pre-172 database in place and keeps existing agent and task rows", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);

      // Roll the database back to the state before migration 172.
      for (const table of [
        "model_catalog",
        "model_catalog_overlay",
        "model_catalog_meta",
        "model_alias_resolutions",
        "harness_model_support",
      ]) {
        db.run(`DROP TABLE ${table}`);
      }
      for (const column of ["resolvedModel", "modelSource", "modelAlias"]) {
        db.run(`ALTER TABLE agent_tasks DROP COLUMN ${column}`);
      }
      for (const column of ["modelTierOverrides", "harnessCliVersion"]) {
        db.run(`ALTER TABLE agents DROP COLUMN ${column}`);
      }
      db.run("DELETE FROM _migrations WHERE version = 172");

      db.run(
        `INSERT INTO agents (id, name, status, createdAt, lastUpdatedAt)
         VALUES ('agent-1', 'worker', 'idle', '2026-09-01', '2026-09-01')`,
      );
      db.run(
        `INSERT INTO agent_tasks (id, task, status, createdAt, lastUpdatedAt)
         VALUES ('task-1', 'existing task', 'pending', '2026-09-01', '2026-09-01')`,
      );

      runMigrations(db);

      expect(
        db
          .query<{ version: number }, []>("SELECT version FROM _migrations WHERE version = 172")
          .get(),
      ).not.toBeNull();
      for (const table of [
        "model_catalog",
        "model_catalog_overlay",
        "model_catalog_meta",
        "model_alias_resolutions",
        "harness_model_support",
      ]) {
        expect(tableExists(db, table)).toBe(true);
      }
      expect(columnNames(db, "agent_tasks")).toEqual(
        expect.arrayContaining(["resolvedModel", "modelSource", "modelAlias"]),
      );
      expect(columnNames(db, "agents")).toEqual(
        expect.arrayContaining(["modelTierOverrides", "harnessCliVersion"]),
      );

      const task = db
        .query<Record<string, unknown>, []>(
          "SELECT task, resolvedModel, modelSource, modelAlias FROM agent_tasks WHERE id = 'task-1'",
        )
        .get();
      expect(task).toEqual({
        task: "existing task",
        resolvedModel: null,
        modelSource: null,
        modelAlias: null,
      });
      const agent = db
        .query<Record<string, unknown>, []>(
          "SELECT name, modelTierOverrides, harnessCliVersion FROM agents WHERE id = 'agent-1'",
        )
        .get();
      expect(agent).toEqual({ name: "worker", modelTierOverrides: null, harnessCliVersion: null });
    } finally {
      db.close();
    }
  });

  test("harness_model_support only accepts ok, unsupported and unknown", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      const insert = (status: string) =>
        db.run(
          `INSERT INTO harness_model_support (harness, cliVersion, modelId, status, checkedAt)
           VALUES ('claude', '2.1.0', ?, ?, 1)`,
          [`m-${status}`, status],
        );
      expect(() => insert("ok")).not.toThrow();
      expect(() => insert("unsupported")).not.toThrow();
      expect(() => insert("unknown")).not.toThrow();
      expect(() => insert("maybe")).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
