import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireProcessLock,
  createPostgresClient,
  OwnershipLostError,
  ProcessLockHeldError,
} from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// The one-process lock (decision D16) and its watch: when the lock session
// ends while the holder runs (a database restart or a terminated backend), the
// holder hears it, and a second process can take the lock.

describe("acquireProcessLock", () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase("lock");
  });

  afterAll(async () => {
    await scratch.drop();
  });

  test("a second process waits, then fails while the first holds the lock", async () => {
    const first = await acquireProcessLock(scratch.url, { waitMs: 0 });
    try {
      await expect(acquireProcessLock(scratch.url, { waitMs: 200, pollMs: 50 })).rejects.toThrow(
        ProcessLockHeldError,
      );
    } finally {
      await first.release();
    }
  });

  test("the holder is told when its lock session ends", async () => {
    const reasons: string[] = [];
    const first = await acquireProcessLock(scratch.url, {
      waitMs: 0,
      watchMs: 50,
      onLost: (reason) => reasons.push(reason),
    });
    const admin = new Bun.SQL({ url: scratch.url, max: 1 });
    try {
      await Bun.sleep(200);
      expect(reasons).toEqual([]);
      // End the lock session, as a database restart does.
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND database = (
            SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      for (let i = 0; i < 40 && reasons.length === 0; i++) await Bun.sleep(50);
      expect(reasons).toHaveLength(1);
      // The lock is free: a second process takes it.
      const second = await acquireProcessLock(scratch.url, { waitMs: 0 });
      await second.release();
    } finally {
      await admin.close();
      await first.release();
    }
  });

  // The write fence: a takeover may happen before the old holder's watch fires.
  // The old process must not commit a write after the new owner holds the lock.
  test("after a takeover the old holder's writes are refused before its watch fires", async () => {
    const admin = new Bun.SQL({ url: scratch.url, max: 1 });
    await admin.unsafe("CREATE TABLE fenced (v text)");
    const first = await acquireProcessLock(scratch.url, { waitMs: 0 });
    const old = createPostgresClient(scratch.url, { max: 2, fence: { ownerPid: first.pid } });
    let second: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
    try {
      await old.run("INSERT INTO fenced (v) VALUES ('before')");
      await old.transaction(async (tx) => {
        await tx.run("INSERT INTO fenced (v) VALUES ('before-tx')");
      });
      await admin.unsafe("SELECT pg_terminate_backend($1)", [first.pid]);
      second = await acquireProcessLock(scratch.url, { waitMs: 2000, pollMs: 50 });

      await expect(old.run("INSERT INTO fenced (v) VALUES ('after')")).rejects.toThrow(
        OwnershipLostError,
      );
      await expect(
        old.transaction(async (tx) => {
          await tx.run("INSERT INTO fenced (v) VALUES ('after-tx')");
        }),
      ).rejects.toThrow(OwnershipLostError);
      await expect(
        old.get<{ v: string }>(
          "WITH w AS (INSERT INTO fenced (v) VALUES ('cte') RETURNING v) SELECT v FROM w",
        ),
      ).rejects.toThrow(OwnershipLostError);
      // Reads still work: only writes are fenced.
      const rows = await old.query<{ v: string }>("SELECT v FROM fenced ORDER BY v");
      expect(rows.map((r) => r.v)).toEqual(["before", "before-tx"]);
    } finally {
      await second?.release();
      await old.close();
      await first.release();
      await admin.unsafe("DROP TABLE fenced");
      await admin.close();
    }
  });

  test("a takeover waits for the old holder's open write transaction to end", async () => {
    const admin = new Bun.SQL({ url: scratch.url, max: 1 });
    await admin.unsafe("CREATE TABLE drained (v text)");
    const first = await acquireProcessLock(scratch.url, { waitMs: 0 });
    const old = createPostgresClient(scratch.url, { max: 2, fence: { ownerPid: first.pid } });
    let second: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
    try {
      let finish = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let started = () => {};
      const inside = new Promise<void>((resolve) => {
        started = resolve;
      });
      const write = old.transaction(async (tx) => {
        await tx.run("INSERT INTO drained (v) VALUES ('in-flight')");
        started();
        await gate;
      });
      await inside;
      await admin.unsafe("SELECT pg_terminate_backend($1)", [first.pid]);
      let acquiredAt = 0;
      const takeover = acquireProcessLock(scratch.url, { waitMs: 5000, pollMs: 50 }).then((l) => {
        acquiredAt = Date.now();
        return l;
      });
      await Bun.sleep(300);
      expect(acquiredAt).toBe(0);
      const committedAt = Date.now();
      finish();
      await write;
      second = await takeover;
      expect(acquiredAt).toBeGreaterThanOrEqual(committedAt);
      const rows = await admin.unsafe("SELECT v FROM drained");
      expect(rows.map((r: { v: string }) => r.v)).toEqual(["in-flight"]);
    } finally {
      await second?.release();
      await old.close();
      await first.release();
      await admin.unsafe("DROP TABLE drained");
      await admin.close();
    }
  });
});
