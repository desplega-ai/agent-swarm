import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireProcessLock, ProcessLockHeldError } from "../src";
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
});
