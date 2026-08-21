import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createBunSqliteClient, type DbClient } from "../be/db-client";

// Cross-process SQLITE_BUSY retry: a second connection on the same file plays
// the external lock holder (litestream checkpoint, CLI access). The client's
// own connection gets a tiny busy_timeout so each driver attempt fails fast
// and the async retry path is what actually bridges the contention window.

const TEST_DB_PATH = "./test-db-client-busy-retry.sqlite";

let main: Database;
let locker: Database;
let client: DbClient;

beforeEach(() => {
  main = new Database(TEST_DB_PATH);
  main.exec("PRAGMA journal_mode = WAL");
  main.exec("PRAGMA busy_timeout = 25");
  main.run("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  main.run("DELETE FROM items");
  locker = new Database(TEST_DB_PATH);
  locker.exec("PRAGMA busy_timeout = 25");
  client = createBunSqliteClient(() => main, { maxWaitMs: 2_000, backoffMs: [25, 50, 100, 200] });
});

afterEach(async () => {
  try {
    locker.run("ROLLBACK");
  } catch {
    // No transaction open; fine.
  }
  locker.close();
  main.close();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

/** Hold the write lock on the second connection for `ms`, then release. */
function holdWriteLock(ms: number): Promise<void> {
  locker.run("BEGIN IMMEDIATE");
  locker.run("INSERT INTO items (name) VALUES ('locker')");
  return new Promise((resolve) =>
    setTimeout(() => {
      locker.run("COMMIT");
      resolve();
    }, ms),
  );
}

describe("db-client SQLITE_BUSY retry", () => {
  test("top-level run bridges an external write lock instead of failing", async () => {
    const released = holdWriteLock(150);
    const result = await client.run("INSERT INTO items (name) VALUES (?)", ["bridged"]);
    expect(result.changes).toBe(1);
    await released;
    const rows = await client.query<{ name: string }>("SELECT name FROM items ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["bridged", "locker"]);
  });

  test("transaction BEGIN IMMEDIATE bridges an external write lock", async () => {
    const released = holdWriteLock(150);
    await client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["tx-a"]);
      await tx.run("INSERT INTO items (name) VALUES (?)", ["tx-b"]);
    });
    await released;
    const rows = await client.query<{ name: string }>(
      "SELECT name FROM items WHERE name LIKE 'tx-%' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(["tx-a", "tx-b"]);
  });

  test("gives up with SQLITE_BUSY when the lock outlives the retry budget", async () => {
    const tightClient = createBunSqliteClient(() => main, { maxWaitMs: 60, backoffMs: [20, 20] });
    const released = holdWriteLock(600);
    await expect(tightClient.run("INSERT INTO items (name) VALUES (?)", ["never"])).rejects.toThrow(
      /database is locked/,
    );
    await released;
  });

  test("non-BUSY errors are not retried", async () => {
    const started = Date.now();
    await expect(client.run("INSERT INTO no_such_table (name) VALUES (?)", ["x"])).rejects.toThrow(
      /no such table/,
    );
    // A retried error would have slept through the backoff schedule.
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("reads proceed under an external write lock without needing the retry path", async () => {
    await client.run("INSERT INTO items (name) VALUES (?)", ["pre-existing"]);
    const released = holdWriteLock(150);
    // WAL readers do not block on the write lock.
    const rows = await client.query<{ name: string }>("SELECT name FROM items");
    expect(rows.map((r) => r.name)).toEqual(["pre-existing"]);
    await released;
  });
});
