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
/** Outstanding holdWriteLock() timer, if any; afterEach waits for it. */
let pendingHold: Promise<void> | null = null;

beforeEach(() => {
  main = new Database(TEST_DB_PATH);
  main.exec("PRAGMA journal_mode = WAL");
  main.exec("PRAGMA busy_timeout = 25");
  main.run("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  main.run("DELETE FROM items");
  locker = new Database(TEST_DB_PATH);
  locker.exec("PRAGMA busy_timeout = 25");
  client = createBunSqliteClient(() => main, {
    maxWaitMs: 2_000,
    // Headroom over the longest holdWriteLock() hold used with this client
    // (400ms): 5 backoff slots sum to 775ms, so even at the minimum 0.5x
    // jitter the writer's final non-retried attempt lands after the
    // external lock releases instead of racing it.
    backoffMs: [25, 50, 100, 200, 400],
    attemptSpinMs: 25,
  });
  pendingHold = null;
});

afterEach(async () => {
  // A test that exits early (a failed assertion, a thrown error) never
  // awaits its own holdWriteLock() promise. Wait for it here so its
  // setTimeout callback runs against a still-open, still-in-transaction
  // `locker` instead of firing later against a rolled-back or already
  // reassigned connection.
  if (pendingHold) {
    await pendingHold;
    pendingHold = null;
  }
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
  const hold = new Promise<void>((resolve) =>
    setTimeout(() => {
      // Only commit if `locker` is still the connection that opened this
      // transaction: afterEach's ROLLBACK (or the next test's beforeEach
      // reassigning `locker`) may already have run by the time this fires.
      if (locker.inTransaction) locker.run("COMMIT");
      resolve();
    }, ms),
  );
  pendingHold = hold;
  return hold;
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
    const tightClient = createBunSqliteClient(() => main, {
      maxWaitMs: 60,
      backoffMs: [20, 20],
      attemptSpinMs: 25,
    });
    const released = holdWriteLock(600);
    let caught: unknown;
    try {
      await tightClient.run("INSERT INTO items (name) VALUES (?)", ["never"]);
    } catch (err) {
      caught = err;
    }
    await released;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/database is locked/);
    expect((caught as { code?: string }).code).toBe("SQLITE_BUSY");
  });

  test("readOnly transaction proceeds at full speed under an external write lock", async () => {
    await client.run("INSERT INTO items (name) VALUES (?)", ["seed"]);
    const order: string[] = [];
    const released = holdWriteLock(400).then(() => {
      order.push("released");
    });
    const names = await client.transaction(
      async (tx) => (await tx.query<{ name: string }>("SELECT name FROM items")).map((r) => r.name),
      { readOnly: true },
    );
    order.push("read");
    await released;
    // Deferred BEGIN never touches the write lock: no busy spin, no retry
    // budget, so the read settles before the locker releases regardless of
    // scheduler noise (an ordering check, not a wall-clock bound).
    expect(order).toEqual(["read", "released"]);
    expect(names).toEqual(["seed"]);
  });

  test("reads flow while a write retries in backoff (FIFO lock released between attempts)", async () => {
    await client.run("INSERT INTO items (name) VALUES (?)", ["reader-food"]);
    const order: string[] = [];
    const released = holdWriteLock(400).then(() => {
      order.push("released");
    });
    const write = client.run("INSERT INTO items (name) VALUES (?)", ["late-write"]);
    // Let the write burn its first attempt and enter async backoff.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = await client.query<{ name: string }>(
      "SELECT name FROM items WHERE name = 'reader-food'",
    );
    order.push("read");
    await released;
    await write;
    const landed = await client.get<{ name: string }>(
      "SELECT name FROM items WHERE name = 'late-write'",
    );
    // Pre-fix, the retrying writer held the FIFO lock across its sleeps and
    // this read queued behind the full retry span; assert the settle order
    // instead of a wall-clock bound so scheduler noise cannot flip the
    // result, and only assert after every started call has been awaited so
    // a failing expectation can never orphan `write` or `released`.
    expect(order).toEqual(["read", "released"]);
    expect(rows.length).toBe(1);
    expect(landed?.name).toBe("late-write");
  });

  test("short spin restores the ambient busy_timeout after a retried attempt", async () => {
    const released = holdWriteLock(120);
    await client.run("INSERT INTO items (name) VALUES (?)", ["spin-check"]);
    await released;
    const row = main.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
    expect(row?.timeout).toBe(25);
  });

  test("non-BUSY errors are not retried", async () => {
    const started = Date.now();
    await expect(client.run("INSERT INTO no_such_table (name) VALUES (?)", ["x"])).rejects.toThrow(
      /no such table/,
    );
    // A retried error would have slept through at least the first backoff
    // step (>=12ms jittered) plus spin overhead; widened from 100ms to
    // absorb --parallel=4 scheduler noise without masking an accidental
    // retry, which would need to clear the full ~775ms backoff schedule.
    expect(Date.now() - started).toBeLessThan(500);
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
