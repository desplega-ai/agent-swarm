import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import { runMigrations } from "../be/migrations/runner";

const TEST_DB_PATH = "./test-migration-failure.sqlite";

const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedMigrationFailureTemplate?: Uint8Array;
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function makeMigration136Fail(database: Database): void {
  database.run("DELETE FROM _migrations WHERE version = 136");
}

beforeEach(async () => {
  closeDb();
  await removeDbFiles();
  testGlobals.__savedMigrationFailureTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
});

afterEach(async () => {
  closeDb();
  testGlobals.__testMigrationTemplate = testGlobals.__savedMigrationFailureTemplate;
  delete testGlobals.__savedMigrationFailureTemplate;
  await removeDbFiles();
});

describe("migration failures", () => {
  test("names the failing migration and preserves the underlying error", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    makeMigration136Fail(database);

    try {
      runMigrations(database);
      throw new Error("expected migration 136 to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Migration 136 (136_task_requester_provenance) failed",
      );
      expect((error as Error).message).toContain("duplicate column name");
      expect((error as Error).cause).toBeInstanceOf(Error);
    } finally {
      database.close();
    }
  });

  test("closes and clears the cached handle after a migration failure", () => {
    const database = new Database(TEST_DB_PATH, { create: true });
    runMigrations(database);
    makeMigration136Fail(database);
    database.close();

    const closeSpy = spyOn(Database.prototype, "close");
    try {
      expect(() => initDb(TEST_DB_PATH)).toThrow(
        "Migration 136 (136_task_requester_provenance) failed",
      );
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // A cached half-migrated handle would be returned here without retrying
      // migrations. Retrying and failing again proves initDb discarded it.
      expect(() => getDb(TEST_DB_PATH)).toThrow(
        "Migration 136 (136_task_requester_provenance) failed",
      );
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
