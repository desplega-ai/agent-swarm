import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  claimKv,
  closeDb,
  countKv,
  deleteKv,
  getDbClient,
  getKv,
  incrKv,
  initDb,
  KvTypeCollisionError,
  listKv,
  sweepExpiredKv,
  sweepExpiredKvPrefix,
  upsertKv,
} from "../be/db";

const TEST_DB_PATH = "./test-kv-storage.sqlite";

const NS = "task:agent:test-agent";

async function clearDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

describe("kv-storage helpers", () => {
  beforeAll(async () => {
    await clearDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await clearDb();
  });

  beforeEach(async () => {
    // Tests use distinct keys per case; nothing to wipe between tests.
    await getDbClient().run(`DELETE FROM kv_entries WHERE namespace = ?`, [NS]);
  });

  test("get returns null for missing keys", async () => {
    expect(await getKv(NS, "missing")).toBeNull();
  });

  test("upsertKv + getKv round-trip json values", async () => {
    const entry = await upsertKv({
      namespace: NS,
      key: "obj",
      value: { a: 1, b: ["two", 3] },
      valueType: "json",
    });
    expect(entry.value).toEqual({ a: 1, b: ["two", 3] });
    expect(entry.valueType).toBe("json");

    const read = await getKv(NS, "obj");
    expect(read?.value).toEqual({ a: 1, b: ["two", 3] });
  });

  test("upsertKv overwrites the existing row in place", async () => {
    await upsertKv({ namespace: NS, key: "k", value: "first", valueType: "string" });
    const second = await upsertKv({
      namespace: NS,
      key: "k",
      value: "second",
      valueType: "string",
    });
    expect(second.value).toBe("second");
    expect((await getKv(NS, "k"))?.value).toBe("second");
  });

  test("string value type stores raw bytes", async () => {
    await upsertKv({ namespace: NS, key: "s", value: 'hello "world"', valueType: "string" });
    const got = await getKv(NS, "s");
    expect(got?.value).toBe('hello "world"');
    expect(got?.valueType).toBe("string");
  });

  test("namespace sweep proactively removes only expired entries", async () => {
    const now = Date.now();
    await upsertKv({
      namespace: NS,
      key: "expired-spill",
      value: "old",
      valueType: "string",
      expiresAt: now - 1,
    });
    await upsertKv({
      namespace: NS,
      key: "live-spill",
      value: "new",
      valueType: "string",
      expiresAt: now + 10_000,
    });

    expect(await sweepExpiredKv(NS, now)).toBe(1);
    expect(await countKv(NS, {})).toBe(1);
    expect((await getKv(NS, "live-spill"))?.value).toBe("new");
  });

  test("prefix sweep removes expired entries across per-agent overflow namespaces", async () => {
    const now = Date.now();
    for (const [namespace, key, expiresAt] of [
      ["mcp:overflow:agent-a", "expired-a", now - 1],
      ["mcp:overflow:agent-b", "expired-b", now - 1],
      ["mcp:overflow:agent-b", "live-b", now + 10_000],
      ["mcp:other:agent-a", "unrelated", now - 1],
    ] as const) {
      await upsertKv({ namespace, key, value: key, valueType: "string", expiresAt });
    }

    expect(await sweepExpiredKvPrefix("mcp:overflow", now)).toBe(2);
    expect((await getKv("mcp:overflow:agent-b", "live-b"))?.value).toBe("live-b");
    const unrelated = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM kv_entries WHERE namespace = ? AND key = ?",
      ["mcp:other:agent-a", "unrelated"],
    );
    expect(unrelated?.count).toBe(1);
  });

  test("integer value type stores as number", async () => {
    await upsertKv({ namespace: NS, key: "n", value: 42, valueType: "integer" });
    expect((await getKv(NS, "n"))?.value).toBe(42);
  });

  test("deleteKv removes and returns true; second delete returns false", async () => {
    await upsertKv({ namespace: NS, key: "del", value: 1, valueType: "integer" });
    expect(await deleteKv(NS, "del")).toBe(true);
    expect(await deleteKv(NS, "del")).toBe(false);
    expect(await getKv(NS, "del")).toBeNull();
  });

  test("TTL: expired key returns null on read AND is deleted from row store", async () => {
    await upsertKv({
      namespace: NS,
      key: "ttl",
      value: "soon",
      valueType: "string",
      expiresAt: Date.now() - 1, // already expired
    });
    expect(await getKv(NS, "ttl")).toBeNull();
    // Row should have been deleted by the lazy sweep
    const raw = await getDbClient().get<{ key: string }>(
      `SELECT key FROM kv_entries WHERE namespace = ? AND key = ?`,
      [NS, "ttl"],
    );
    expect(raw).toBeNull();
  });

  test("TTL: non-expired keys are returned normally", async () => {
    await upsertKv({
      namespace: NS,
      key: "live",
      value: "now",
      valueType: "string",
      expiresAt: Date.now() + 60_000,
    });
    expect((await getKv(NS, "live"))?.value).toBe("now");
  });

  test("listKv filters expired but does not delete them inline", async () => {
    await upsertKv({
      namespace: NS,
      key: "exp",
      value: "x",
      valueType: "string",
      expiresAt: Date.now() - 1,
    });
    await upsertKv({ namespace: NS, key: "alive", value: "x", valueType: "string" });
    const all = await listKv(NS, { limit: 100, offset: 0 });
    expect(all.map((e) => e.key)).toEqual(["alive"]);
    // The expired row should still exist on disk because listKv doesn't sweep.
    const stillThere = await getDbClient().get<{ key: string }>(
      `SELECT key FROM kv_entries WHERE namespace = ? AND key = ?`,
      [NS, "exp"],
    );
    expect(stillThere?.key).toBe("exp");
  });

  test("listKv prefix filter & ordering", async () => {
    await upsertKv({ namespace: NS, key: "a-1", value: 1, valueType: "integer" });
    await upsertKv({ namespace: NS, key: "a-2", value: 2, valueType: "integer" });
    await upsertKv({ namespace: NS, key: "b-1", value: 3, valueType: "integer" });
    const a = await listKv(NS, { prefix: "a-", limit: 100, offset: 0 });
    expect(a.map((e) => e.key)).toEqual(["a-1", "a-2"]);
    expect(await countKv(NS, { prefix: "a-" })).toBe(2);
    expect(await countKv(NS, {})).toBe(3);
  });

  test("listKv prefix escapes SQL LIKE wildcards", async () => {
    await upsertKv({ namespace: NS, key: "x_1", value: 1, valueType: "integer" });
    await upsertKv({ namespace: NS, key: "xyz", value: 2, valueType: "integer" });
    const exact = await listKv(NS, { prefix: "x_", limit: 100, offset: 0 });
    // Without escaping, `_` would match any char and we'd get both rows.
    expect(exact.map((e) => e.key)).toEqual(["x_1"]);
  });

  test("incrKv creates from missing", async () => {
    const entry = await incrKv(NS, "counter", 3);
    expect(entry.value).toBe(3);
    expect(entry.valueType).toBe("integer");
  });

  test("incrKv increments existing integer", async () => {
    await incrKv(NS, "counter", 1);
    await incrKv(NS, "counter", 4);
    const entry = await incrKv(NS, "counter", -2);
    expect(entry.value).toBe(3);
  });

  test("incrKv treats expired row as missing", async () => {
    await upsertKv({
      namespace: NS,
      key: "decay",
      value: 100,
      valueType: "integer",
      expiresAt: Date.now() - 1,
    });
    const entry = await incrKv(NS, "decay", 5);
    expect(entry.value).toBe(5);
    expect(entry.expiresAt).toBeNull();
  });

  test("incrKv collides with json valueType (409 surface)", async () => {
    await upsertKv({ namespace: NS, key: "obj", value: { n: 1 }, valueType: "json" });
    let thrown: unknown;
    try {
      await incrKv(NS, "obj", 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KvTypeCollisionError);
    if (thrown instanceof KvTypeCollisionError) {
      expect(thrown.existingType).toBe("json");
    }
  });

  test("incrKv collides with string valueType", async () => {
    await upsertKv({ namespace: NS, key: "str", value: "5", valueType: "string" });
    await expect(incrKv(NS, "str", 1)).rejects.toThrow(KvTypeCollisionError);
  });

  test("2 MiB exactly succeeds; 2 MiB + 1 byte rejected via upsert encoder is N/A — boundary lives in HTTP/MCP layer", async () => {
    // The DB helpers themselves don't enforce size — that's the HTTP/MCP
    // boundary. But we can store a 2 MiB string here to prove the engine
    // accepts it. The 2 MiB + 1 case is covered by the HTTP test.
    const twoMiB = "x".repeat(2 * 1024 * 1024);
    const entry = await upsertKv({ namespace: NS, key: "big", value: twoMiB, valueType: "string" });
    expect((entry.value as string).length).toBe(2 * 1024 * 1024);
  });

  test("claimKv: first caller wins, live entry blocks the rest", async () => {
    const key = `claim-${crypto.randomUUID()}`;
    expect(
      await claimKv({ namespace: NS, key, value: 1, valueType: "integer", expiresAt: null }),
    ).toBe(true);
    expect(
      await claimKv({ namespace: NS, key, value: 1, valueType: "integer", expiresAt: null }),
    ).toBe(false);
  });

  test("claimKv: two concurrent claims produce exactly one winner", async () => {
    // Webhook-dedup shape (markKapsoMessageSeen): a get-then-upsert pair lets
    // both concurrent deliveries win; the single conditional write must not.
    const key = `claim-race-${crypto.randomUUID()}`;
    const results = await Promise.all([
      claimKv({ namespace: NS, key, value: 1, valueType: "integer", expiresAt: null }),
      claimKv({ namespace: NS, key, value: 1, valueType: "integer", expiresAt: null }),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });

  test("claimKv: an expired entry can be re-claimed (lazy TTL, mirrors getKv)", async () => {
    const key = `claim-ttl-${crypto.randomUUID()}`;
    expect(
      await claimKv({
        namespace: NS,
        key,
        value: 1,
        valueType: "integer",
        expiresAt: Date.now() - 1000,
      }),
    ).toBe(true);
    expect(
      await claimKv({
        namespace: NS,
        key,
        value: 1,
        valueType: "integer",
        expiresAt: Date.now() + 60_000,
      }),
    ).toBe(true);
    // Now live again — further claims lose.
    expect(
      await claimKv({ namespace: NS, key, value: 1, valueType: "integer", expiresAt: null }),
    ).toBe(false);
  });
});

describe("kv-storage namespaces are isolated", () => {
  beforeAll(async () => {
    await clearDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await clearDb();
  });

  test("different namespaces with same key are independent", async () => {
    await upsertKv({ namespace: "task:agent:a", key: "shared", value: "A", valueType: "string" });
    await upsertKv({ namespace: "task:agent:b", key: "shared", value: "B", valueType: "string" });
    expect((await getKv("task:agent:a", "shared"))?.value).toBe("A");
    expect((await getKv("task:agent:b", "shared"))?.value).toBe("B");
  });
});
