import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatRepository, Storage } from "../../src";
import type { ContractEngine } from "./env";

export function chatContract(engine: ContractEngine): void {
  describe(`chat repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: ChatRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.chat;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("subscriptions are idempotent", async () => {
      await repo.subscribe("t1");
      await repo.subscribe("t1");
      expect(await repo.isSubscribed("t1")).toBe(true);
      await repo.unsubscribe("t1");
      expect(await repo.isSubscribed("t1")).toBe(false);
    });

    test("a lock is taken only when free or expired, and only its holder extends it", async () => {
      expect(await repo.acquireLock("t1", "a", 1_000, 0)).toBe(true);
      expect(await repo.acquireLock("t1", "b", 2_000, 500)).toBe(false);
      expect(await repo.extendLock("t1", "b", 3_000, 500)).toBe(false);
      expect(await repo.extendLock("t1", "a", 3_000, 500)).toBe(true);
      expect(await repo.acquireLock("t1", "b", 4_000, 2_999)).toBe(false);
      expect(await repo.acquireLock("t1", "b", 4_000, 3_000)).toBe(true);
      expect(await repo.extendLock("t1", "b", 5_000, 4_000)).toBe(false);
      await repo.releaseLock("t1", "a");
      expect(await repo.acquireLock("t1", "c", 9_000, 3_500)).toBe(false);
      await repo.releaseLock("t1", "b");
      expect(await repo.acquireLock("t1", "c", 9_000, 3_500)).toBe(true);
      await repo.forceReleaseLock("t1");
      expect(await repo.acquireLock("t1", "d", 9_000, 3_500)).toBe(true);
    });

    test("kv: set, conditional set, expiry delete", async () => {
      await repo.setKv("k", '"v1"', null);
      expect(await repo.getKv("k")).toEqual({ value: '"v1"', expires_at: null });
      // No expiry: never replaced by setKvIfAbsent.
      expect(await repo.setKvIfAbsent("k", '"v2"', 100, 50)).toBe(false);
      await repo.setKv("k", '"v3"', 100);
      expect(await repo.setKvIfAbsent("k", '"v4"', 200, 99)).toBe(false);
      expect(await repo.setKvIfAbsent("k", '"v4"', 200, 100)).toBe(true);
      expect(await repo.getKv("k")).toEqual({ value: '"v4"', expires_at: 200 });
      expect(await repo.setKvIfAbsent("new", "1", null, 0)).toBe(true);
      await repo.deleteExpiredKv("k", 199);
      expect(await repo.getKv("k")).not.toBeNull();
      await repo.deleteExpiredKv("k", 200);
      expect(await repo.getKv("k")).toBeNull();
      await repo.deleteKv("new");
      expect(await repo.getKv("new")).toBeNull();
    });

    test("lists append in seq order, trim to the newest and expire", async () => {
      // Values are JSON text the caller encodes (a jsonb column on Postgres).
      for (const value of ['"a"', '"b"', '"c"', '"d"']) await repo.appendListItem("l", value, null);
      expect(await repo.listItems("l", 0)).toEqual(['"a"', '"b"', '"c"', '"d"']);
      await repo.trimList("l", 2);
      expect(await repo.listItems("l", 0)).toEqual(['"c"', '"d"']);
      await repo.appendListItem("l", '"e"', null);
      expect(await repo.listItems("l", 0)).toEqual(['"c"', '"d"', '"e"']);
      await repo.setListExpiry("l", 100);
      expect(await repo.listItems("l", 99)).toEqual(['"c"', '"d"', '"e"']);
      expect(await repo.listItems("l", 100)).toEqual([]);
      await repo.deleteExpiredList("l", 99);
      expect(await repo.listItems("l", 0)).toHaveLength(3);
      await repo.deleteExpiredList("l", 100);
      expect(await repo.listItems("l", 0)).toEqual([]);
    });

    test("queue keeps the newest entries and dequeues the oldest", async () => {
      for (const entry of ["1", "2", "3"]) await repo.enqueue("t1", entry);
      await repo.enqueue("t2", "x");
      await repo.trimQueue("t1", 2);
      expect(await repo.queueDepth("t1")).toBe(2);
      expect(await repo.queueDepth("t2")).toBe(1);
      const first = await repo.firstQueued("t1");
      expect(first?.entry).toBe("2");
      await repo.deleteQueued(first!.id);
      expect((await repo.firstQueued("t1"))?.entry).toBe("3");
      await repo.trimQueue("t2", 0);
      expect(await repo.firstQueued("t2")).toBeNull();
    });

    test("sweepExpired removes expired kv, list items and locks only", async () => {
      await repo.setKv("old", "1", 10);
      await repo.setKv("forever", "1", null);
      await repo.appendListItem("l-old", "1", 10);
      await repo.appendListItem("l-forever", "1", null);
      await repo.acquireLock("t-old", "a", 10, 0);
      await repo.acquireLock("t-live", "a", 100, 0);
      await repo.sweepExpired(10);
      expect(await repo.getKv("old")).toBeNull();
      expect(await repo.getKv("forever")).not.toBeNull();
      expect(await repo.listItems("l-old", 0)).toEqual([]);
      expect(await repo.listItems("l-forever", 0)).toEqual(["1"]);
      expect(await repo.acquireLock("t-old", "b", 50, 0)).toBe(true);
      expect(await repo.acquireLock("t-live", "b", 200, 0)).toBe(false);
    });
  });
}
