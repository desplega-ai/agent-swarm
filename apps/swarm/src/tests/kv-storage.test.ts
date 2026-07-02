import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  countKv,
  deleteKv,
  getDb,
  getKv,
  incrKv,
  initDb,
  KvTypeCollisionError,
  listKv,
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

  beforeEach(() => {
    // Tests use distinct keys per case; nothing to wipe between tests.
    getDb().run(`DELETE FROM kv_entries WHERE namespace = ?`, [NS]);
  });

  test("get returns null for missing keys", () => {
    expect(getKv(NS, "missing")).toBeNull();
  });

  test("upsertKv + getKv round-trip json values", () => {
    const entry = upsertKv({
      namespace: NS,
      key: "obj",
      value: { a: 1, b: ["two", 3] },
      valueType: "json",
    });
    expect(entry.value).toEqual({ a: 1, b: ["two", 3] });
    expect(entry.valueType).toBe("json");

    const read = getKv(NS, "obj");
    expect(read?.value).toEqual({ a: 1, b: ["two", 3] });
  });

  test("upsertKv overwrites the existing row in place", () => {
    upsertKv({ namespace: NS, key: "k", value: "first", valueType: "string" });
    const second = upsertKv({ namespace: NS, key: "k", value: "second", valueType: "string" });
    expect(second.value).toBe("second");
    expect(getKv(NS, "k")?.value).toBe("second");
  });

  test("string value type stores raw bytes", () => {
    upsertKv({ namespace: NS, key: "s", value: 'hello "world"', valueType: "string" });
    const got = getKv(NS, "s");
    expect(got?.value).toBe('hello "world"');
    expect(got?.valueType).toBe("string");
  });

  test("integer value type stores as number", () => {
    upsertKv({ namespace: NS, key: "n", value: 42, valueType: "integer" });
    expect(getKv(NS, "n")?.value).toBe(42);
  });

  test("deleteKv removes and returns true; second delete returns false", () => {
    upsertKv({ namespace: NS, key: "del", value: 1, valueType: "integer" });
    expect(deleteKv(NS, "del")).toBe(true);
    expect(deleteKv(NS, "del")).toBe(false);
    expect(getKv(NS, "del")).toBeNull();
  });

  test("TTL: expired key returns null on read AND is deleted from row store", () => {
    upsertKv({
      namespace: NS,
      key: "ttl",
      value: "soon",
      valueType: "string",
      expiresAt: Date.now() - 1, // already expired
    });
    expect(getKv(NS, "ttl")).toBeNull();
    // Row should have been deleted by the lazy sweep
    const raw = getDb()
      .prepare<{ key: string }, [string, string]>(
        `SELECT key FROM kv_entries WHERE namespace = ? AND key = ?`,
      )
      .get(NS, "ttl");
    expect(raw).toBeNull();
  });

  test("TTL: non-expired keys are returned normally", () => {
    upsertKv({
      namespace: NS,
      key: "live",
      value: "now",
      valueType: "string",
      expiresAt: Date.now() + 60_000,
    });
    expect(getKv(NS, "live")?.value).toBe("now");
  });

  test("listKv filters expired but does not delete them inline", () => {
    upsertKv({
      namespace: NS,
      key: "exp",
      value: "x",
      valueType: "string",
      expiresAt: Date.now() - 1,
    });
    upsertKv({ namespace: NS, key: "alive", value: "x", valueType: "string" });
    const all = listKv(NS, { limit: 100, offset: 0 });
    expect(all.map((e) => e.key)).toEqual(["alive"]);
    // The expired row should still exist on disk because listKv doesn't sweep.
    const stillThere = getDb()
      .prepare<{ key: string }, [string, string]>(
        `SELECT key FROM kv_entries WHERE namespace = ? AND key = ?`,
      )
      .get(NS, "exp");
    expect(stillThere?.key).toBe("exp");
  });

  test("listKv prefix filter & ordering", () => {
    upsertKv({ namespace: NS, key: "a-1", value: 1, valueType: "integer" });
    upsertKv({ namespace: NS, key: "a-2", value: 2, valueType: "integer" });
    upsertKv({ namespace: NS, key: "b-1", value: 3, valueType: "integer" });
    const a = listKv(NS, { prefix: "a-", limit: 100, offset: 0 });
    expect(a.map((e) => e.key)).toEqual(["a-1", "a-2"]);
    expect(countKv(NS, { prefix: "a-" })).toBe(2);
    expect(countKv(NS, {})).toBe(3);
  });

  test("listKv prefix escapes SQL LIKE wildcards", () => {
    upsertKv({ namespace: NS, key: "x_1", value: 1, valueType: "integer" });
    upsertKv({ namespace: NS, key: "xyz", value: 2, valueType: "integer" });
    const exact = listKv(NS, { prefix: "x_", limit: 100, offset: 0 });
    // Without escaping, `_` would match any char and we'd get both rows.
    expect(exact.map((e) => e.key)).toEqual(["x_1"]);
  });

  test("incrKv creates from missing", () => {
    const entry = incrKv(NS, "counter", 3);
    expect(entry.value).toBe(3);
    expect(entry.valueType).toBe("integer");
  });

  test("incrKv increments existing integer", () => {
    incrKv(NS, "counter", 1);
    incrKv(NS, "counter", 4);
    const entry = incrKv(NS, "counter", -2);
    expect(entry.value).toBe(3);
  });

  test("incrKv treats expired row as missing", () => {
    upsertKv({
      namespace: NS,
      key: "decay",
      value: 100,
      valueType: "integer",
      expiresAt: Date.now() - 1,
    });
    const entry = incrKv(NS, "decay", 5);
    expect(entry.value).toBe(5);
    expect(entry.expiresAt).toBeNull();
  });

  test("incrKv collides with json valueType (409 surface)", () => {
    upsertKv({ namespace: NS, key: "obj", value: { n: 1 }, valueType: "json" });
    let thrown: unknown;
    try {
      incrKv(NS, "obj", 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KvTypeCollisionError);
    if (thrown instanceof KvTypeCollisionError) {
      expect(thrown.existingType).toBe("json");
    }
  });

  test("incrKv collides with string valueType", () => {
    upsertKv({ namespace: NS, key: "str", value: "5", valueType: "string" });
    expect(() => incrKv(NS, "str", 1)).toThrow(KvTypeCollisionError);
  });

  test("2 MiB exactly succeeds; 2 MiB + 1 byte rejected via upsert encoder is N/A — boundary lives in HTTP/MCP layer", () => {
    // The DB helpers themselves don't enforce size — that's the HTTP/MCP
    // boundary. But we can store a 2 MiB string here to prove the engine
    // accepts it. The 2 MiB + 1 case is covered by the HTTP test.
    const twoMiB = "x".repeat(2 * 1024 * 1024);
    const entry = upsertKv({ namespace: NS, key: "big", value: twoMiB, valueType: "string" });
    expect((entry.value as string).length).toBe(2 * 1024 * 1024);
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

  test("different namespaces with same key are independent", () => {
    upsertKv({ namespace: "task:agent:a", key: "shared", value: "A", valueType: "string" });
    upsertKv({ namespace: "task:agent:b", key: "shared", value: "B", valueType: "string" });
    expect(getKv("task:agent:a", "shared")?.value).toBe("A");
    expect(getKv("task:agent:b", "shared")?.value).toBe("B");
  });
});
