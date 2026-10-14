import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { QueueEntry } from "chat";
import { closeDb, getDbClient, initDb } from "../be/db";
import { SqliteChatState, sweepExpired } from "../integrations/chat-sdk/state";

const TEST_DB_PATH = "./test-chat-sdk-state.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

const state = new SqliteChatState();

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await state.connect();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

function entry(id: string, expiresAt = Date.now() + 60_000): QueueEntry {
  return { enqueuedAt: Date.now(), expiresAt, message: { id } as unknown as QueueEntry["message"] };
}

describe("SqliteChatState locks", () => {
  test("acquire is exclusive until release", async () => {
    const lock = await state.acquireLock("telegram:1", 60_000);
    expect(lock).not.toBeNull();
    expect(await state.acquireLock("telegram:1", 60_000)).toBeNull();
    await state.releaseLock(lock!);
    expect(await state.acquireLock("telegram:1", 60_000)).not.toBeNull();
    await state.forceReleaseLock("telegram:1");
  });

  test("release with a stale token keeps the current holder", async () => {
    const lock = await state.acquireLock("telegram:2", 60_000);
    await state.releaseLock({ ...lock!, token: "other" });
    expect(await state.acquireLock("telegram:2", 60_000)).toBeNull();
    await state.forceReleaseLock("telegram:2");
    expect(await state.acquireLock("telegram:2", 60_000)).not.toBeNull();
    await state.forceReleaseLock("telegram:2");
  });

  test("an expired lock can be taken over and no longer extends", async () => {
    const first = await state.acquireLock("telegram:3", 1);
    await Bun.sleep(5);
    const second = await state.acquireLock("telegram:3", 60_000);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);
    expect(await state.extendLock(first!, 60_000)).toBe(false);
    expect(await state.extendLock(second!, 60_000)).toBe(true);
    await state.releaseLock(second!);
  });
});

describe("SqliteChatState key-value", () => {
  test("get/set/delete round trip JSON values", async () => {
    await state.set("k:obj", { a: 1, b: ["x"] });
    expect(await state.get<{ a: number; b: string[] }>("k:obj")).toEqual({ a: 1, b: ["x"] });
    await state.delete("k:obj");
    expect(await state.get("k:obj")).toBeNull();
  });

  test("ttl expires values and 0 means no expiry", async () => {
    await state.set("k:short", "v", 1);
    await state.set("k:forever", "v", 0);
    await Bun.sleep(5);
    expect(await state.get("k:short")).toBeNull();
    expect(await state.get("k:forever")).toBe("v");
  });

  test("setIfNotExists claims once and reclaims after expiry", async () => {
    expect(await state.setIfNotExists("dedupe:telegram:1", true, 60_000)).toBe(true);
    expect(await state.setIfNotExists("dedupe:telegram:1", true, 60_000)).toBe(false);
    expect(await state.setIfNotExists("dedupe:telegram:2", true, 1)).toBe(true);
    await Bun.sleep(5);
    expect(await state.setIfNotExists("dedupe:telegram:2", true, 60_000)).toBe(true);
  });
});

describe("SqliteChatState lists", () => {
  test("append keeps the newest maxLength in order", async () => {
    for (let i = 1; i <= 5; i++) await state.appendToList("list:a", i, { maxLength: 3 });
    expect(await state.getList<number>("list:a")).toEqual([3, 4, 5]);
  });

  test("ttl is reset on every append and an expired list starts over", async () => {
    await state.appendToList("list:b", "one", { ttlMs: 1 });
    await Bun.sleep(5);
    expect(await state.getList("list:b")).toEqual([]);
    await state.appendToList("list:b", "two", { ttlMs: 60_000 });
    expect(await state.getList("list:b")).toEqual(["two"]);

    // The second append moves every row of the list to the new expiry. A short
    // first TTL would race the second append under CI load, so read the
    // stored expiries instead of sleeping past them.
    await state.appendToList("list:c", "x", { ttlMs: 30_000 });
    const before = Date.now();
    await state.appendToList("list:c", "y", { ttlMs: 60_000 });
    const row = await getDbClient().get<{ lo: number; hi: number }>(
      "SELECT MIN(expires_at) AS lo, MAX(expires_at) AS hi FROM chat_lists WHERE key = ?",
      ["list:c"],
    );
    expect(row?.lo).toBe(row?.hi);
    expect(row?.lo).toBeGreaterThanOrEqual(before + 60_000);
    expect(await state.getList("list:c")).toEqual(["x", "y"]);
  });
});

describe("SqliteChatState queue", () => {
  test("FIFO with maxSize dropping the oldest", async () => {
    expect(await state.enqueue("telegram:q", entry("m1"), 2)).toBe(1);
    expect(await state.enqueue("telegram:q", entry("m2"), 2)).toBe(2);
    expect(await state.enqueue("telegram:q", entry("m3"), 2)).toBe(2);
    expect(await state.queueDepth("telegram:q")).toBe(2);
    expect((await state.dequeue("telegram:q"))?.message.id).toBe("m2");
    expect((await state.dequeue("telegram:q"))?.message.id).toBe("m3");
    expect(await state.dequeue("telegram:q")).toBeNull();
  });

  test("dequeue returns expired entries (the core filters them)", async () => {
    await state.enqueue("telegram:q2", entry("old", Date.now() - 1), 5);
    expect((await state.dequeue("telegram:q2"))?.message.id).toBe("old");
  });
});

describe("SqliteChatState subscriptions", () => {
  test("subscriptions survive disconnect", async () => {
    await state.subscribe("telegram:sub");
    await state.subscribe("telegram:sub");
    expect(await state.isSubscribed("telegram:sub")).toBe(true);
    await state.disconnect();
    await state.connect();
    expect(await state.isSubscribed("telegram:sub")).toBe(true);
    await state.unsubscribe("telegram:sub");
    expect(await state.isSubscribed("telegram:sub")).toBe(false);
  });
});

describe("sweepExpired", () => {
  test("removes expired kv, list and lock rows only", async () => {
    await state.set("sweep:old", 1, 1);
    await state.set("sweep:new", 1, 60_000);
    await state.appendToList("sweep:list", 1, { ttlMs: 1 });
    await state.acquireLock("telegram:sweep", 1);
    await Bun.sleep(5);
    await sweepExpired();
    const db = getDbClient();
    expect(await db.get("SELECT key FROM chat_state_kv WHERE key = 'sweep:old'")).toBeNull();
    expect(await db.get("SELECT key FROM chat_state_kv WHERE key = 'sweep:new'")).not.toBeNull();
    expect(await db.get("SELECT key FROM chat_lists WHERE key = 'sweep:list'")).toBeNull();
    expect(
      await db.get("SELECT thread_id FROM chat_locks WHERE thread_id = 'telegram:sweep'"),
    ).toBeNull();
  });
});
