import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KvRepository, Storage } from "../../src";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

const NOW = 1_800_000_000_000;

export function kvContract(engine: ContractEngine): void {
  describe(`kv repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: KvRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.kv;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const put = (namespace: string, key: string, value: string, expiresAt: number | null = null) =>
      storage.executor.run(sql`
        INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
        VALUES (${namespace}, ${key}, ${value}, 'json', ${expiresAt}, ${NOW}, ${NOW})`);

    test("upsertJsonValue inserts, then replaces the value and clears the expiry", async () => {
      await put("ns", "k", '"old"', NOW + 5);
      await repo.upsertJsonValue("ns", "k", '{"a":1}', NOW + 10);
      await repo.upsertJsonValue("ns", "fresh", "[]", NOW);
      const row = await storage.executor.get<Record<string, unknown>>(
        sql`SELECT value, value_type, expires_at, created_at, updated_at FROM kv_entries WHERE namespace = ${"ns"} AND key = ${"k"}`,
      );
      expect(row).toEqual({
        value: '{"a":1}',
        value_type: "json",
        expires_at: null,
        created_at: NOW,
        updated_at: NOW + 10,
      });
      expect(await repo.getValue("ns", "fresh")).toEqual({ value: "[]", value_type: "json" });
      expect(await repo.getValue("ns", "missing")).toBeNull();
    });

    test("keyAfter walks key windows, expired rows included", async () => {
      for (const key of ["m/a", "m/b", "m/c", "m/d", "n/a"]) await put("ns", key, "1", NOW - 1);
      expect(await repo.keyAfter("ns", "m0", "m/", 0)).toBe("m/a");
      expect(await repo.keyAfter("ns", "m0", "m/a", 2)).toBe("m/d");
      expect(await repo.keyAfter("ns", "m0", "m/a", 3)).toBeNull();
    });

    test("listKeysLike: escaped underscore, ASCII case folded, key order", async () => {
      await put("ns", "_room/b", "1");
      await put("ns", "_ROOM/a", "1");
      await put("ns", "xroom/c", "1");
      await put("other", "_room/z", "1");
      expect(await repo.listKeysLike("ns", "\\_room/%")).toEqual(["_ROOM/a", "_room/b"]);
    });

    test("live reads skip expired rows and keep key order", async () => {
      await put("ns", "r/2", "2");
      await put("ns", "r/1", "1", NOW + 1);
      await put("ns", "r/3", "3", NOW);
      await put("ns", "s/1", "9");
      expect(await repo.listLiveKeys("ns", "r/", "r0", NOW, 10)).toEqual(["r/1", "r/2"]);
      expect(await repo.listLiveKeys("ns", "r/", "r0", NOW, 1)).toEqual(["r/1"]);
      expect(await repo.listLiveValues("ns", ["r/2", "r/3", "r/1"], NOW)).toEqual([
        { value: "1", value_type: "json" },
        { value: "2", value_type: "json" },
      ]);
      expect(await repo.listLiveValues("ns", [], NOW)).toEqual([]);
      expect(await repo.listLiveEntriesAfter("ns", "r/", "r0", "r/1", NOW, 10)).toEqual([
        { key: "r/2", value: "2", value_type: "json" },
      ]);
    });

    test("deleteNamespaceBatch deletes in key order; setExpiresAt reports changes", async () => {
      for (const key of ["c", "a", "b"]) await put("ns", key, "1", NOW - 1);
      await put("keep", "a", "1");
      expect(await repo.deleteNamespaceBatch("ns", 2)).toBe(2);
      expect(await repo.getValue("ns", "c")).not.toBeNull();
      expect(await repo.deleteNamespaceBatch("ns", 2)).toBe(1);
      expect(await repo.deleteNamespaceBatch("ns", 2)).toBe(0);
      expect(await repo.setExpiresAt("keep", "a", NOW)).toBe(1);
      expect(await repo.setExpiresAt("keep", "missing", NOW)).toBe(0);
      expect(await repo.listLiveKeys("keep", "a", "b", NOW, 10)).toEqual([]);
    });
  });
}
