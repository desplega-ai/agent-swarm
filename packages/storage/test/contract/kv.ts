import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KvRepository, KvRow, Storage } from "../../src";
import { KV_BATCH_KEYS, KV_BATCH_ROWS, sql } from "../../src";
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

    const entry = (namespace: string, key: string, extra: Partial<KvRow> = {}): KvRow => ({
      namespace,
      key,
      value: '{"kind":"a","n":1}',
      value_type: "json",
      expires_at: null,
      created_at: 1,
      updated_at: 1,
      ...extra,
    });

    test("full rows: upsert keeps created_at, claim only replaces expired, delete", async () => {
      expect(await repo.upsertEntry(entry("ns", "k"))).toEqual(entry("ns", "k"));
      const replaced = await repo.upsertEntry(
        entry("ns", "k", { value: "2", value_type: "integer", created_at: 9, updated_at: 9 }),
      );
      expect(replaced).toEqual(
        entry("ns", "k", { value: "2", value_type: "integer", created_at: 1, updated_at: 9 }),
      );
      expect(await repo.claimEntry(entry("ns", "k", { value: "x" }), 5)).toBe(0);
      await repo.upsertEntry(entry("ns", "k", { expires_at: 5 }));
      expect(await repo.claimEntry(entry("ns", "k", { value: "x" }), 5)).toBe(1);
      expect(await repo.claimEntry(entry("ns", "new"), 5)).toBe(1);
      expect((await repo.setEntryValue("ns", "k", "y", 7))?.value).toBe("y");
      expect(await repo.setEntryValue("ns", "zz", "y", 7)).toBeNull();
      expect((await repo.findEntry("ns", "k"))?.updated_at).toBe(7);
      expect(await repo.deleteEntry("ns", "k")).toBe(1);
      expect(await repo.deleteEntry("ns", "k")).toBe(0);
    });

    test("compare-and-set: replace and delete only while the value matches, expired or not", async () => {
      await repo.upsertEntry(entry("ns", "cas", { value: '"a"', expires_at: 5 }));
      const next = entry("ns", "cas", { value: '"b"', expires_at: 50, updated_at: 9 });
      expect(await repo.replaceEntryIfValue(next, '"x"')).toBe(0);
      expect(await repo.replaceEntryIfValue(next, '"a"')).toBe(1);
      expect(await repo.findEntry("ns", "cas")).toEqual(
        entry("ns", "cas", { value: '"b"', expires_at: 50, updated_at: 9 }),
      );
      expect(await repo.replaceEntryIfValue(entry("ns", "none"), '"a"')).toBe(0);
      expect(await repo.deleteEntryIfValue("ns", "cas", '"a"')).toBe(0);
      expect(await repo.deleteEntryIfValue("ns", "cas", '"b"')).toBe(1);
      expect(await repo.findEntry("ns", "cas")).toBeNull();
    });

    test("batch upsert: keeps created_at, last duplicate wins, spans several statements", async () => {
      await repo.upsertEntry(entry("ns", "old", { expires_at: 5 }));
      await repo.upsertEntries([]);
      await repo.upsertEntries([
        entry("ns", "old", { value: "2", value_type: "integer", created_at: 9, updated_at: 9 }),
        entry("ns", "new", { value: '"first"' }),
        entry("other", "new"),
        entry("ns", "new", { value: '"last"', updated_at: 3 }),
      ]);
      expect(await repo.findEntry("ns", "old")).toEqual(
        entry("ns", "old", { value: "2", value_type: "integer", created_at: 1, updated_at: 9 }),
      );
      expect(await repo.findEntry("ns", "new")).toEqual(
        entry("ns", "new", { value: '"last"', updated_at: 3 }),
      );
      expect(await repo.findEntry("other", "new")).toEqual(entry("other", "new"));

      const many = Array.from({ length: KV_BATCH_ROWS * 2 + 1 }, (_, i) =>
        entry("bulk", `k${String(i).padStart(4, "0")}`, { value: String(i) }),
      );
      await repo.upsertEntries(many);
      expect(await repo.countLiveEntries("bulk", NOW, {})).toBe(many.length);
    });

    test("batch find and delete: listed keys only, expired rows included, any key count", async () => {
      await repo.upsertEntry(entry("ns", "a"));
      await repo.upsertEntry(entry("ns", "b", { expires_at: 1 }));
      await repo.upsertEntry(entry("ns", "c"));
      await repo.upsertEntry(entry("other", "a"));
      const found = await repo.findEntries("ns", ["b", "a", "missing", "a"]);
      expect(found.map((r) => r.key).sort()).toEqual(["a", "b"]);
      expect(found.find((r) => r.key === "b")).toEqual(entry("ns", "b", { expires_at: 1 }));
      expect(await repo.findEntries("ns", [])).toEqual([]);
      expect(await repo.deleteEntries("ns", [])).toBe(0);
      expect(await repo.deleteEntries("ns", ["a", "b", "missing"])).toBe(2);
      expect(await repo.findEntry("ns", "c")).not.toBeNull();
      expect(await repo.findEntry("other", "a")).not.toBeNull();

      const keys = Array.from({ length: KV_BATCH_KEYS + 1 }, (_, i) => `k${i}`);
      await repo.upsertEntries(keys.map((key) => entry("wide", key)));
      expect((await repo.findEntries("wide", keys)).length).toBe(keys.length);
      expect(await repo.deleteEntries("wide", keys)).toBe(keys.length);
      expect(await repo.countLiveEntries("wide", NOW, {})).toBe(0);
    });

    test("expiry sweeps: one namespace, and a namespace family in batches", async () => {
      await repo.upsertEntry(entry("fam", "a", { expires_at: 1 }));
      await repo.upsertEntry(entry("fam:x", "a", { expires_at: 1 }));
      await repo.upsertEntry(entry("fam:y", "b", { expires_at: 1 }));
      await repo.upsertEntry(entry("famous", "a", { expires_at: 1 }));
      await repo.upsertEntry(entry("fam:z", "live", { expires_at: 100 }));
      expect(await repo.deleteExpiredInFamilyBatch("fam", "fam:%", 10, 2)).toBe(2);
      expect(await repo.deleteExpiredInFamilyBatch("fam", "fam:%", 10, 2)).toBe(1);
      expect(await repo.deleteExpiredInFamilyBatch("fam", "fam:%", 10, 2)).toBe(0);
      expect(await repo.findEntry("famous", "a")).not.toBeNull();
      expect(await repo.deleteExpired("famous", 10)).toBe(1);
      expect(await repo.findEntry("fam:z", "live")).not.toBeNull();
    });

    test("namespace-pattern purge deletes live and expired entries in batches", async () => {
      await repo.upsertEntry(entry("room:a:x", "k"));
      await repo.upsertEntry(entry("room:a:y", "k", { expires_at: 1 }));
      await repo.upsertEntry(entry("room:a:y", "j"));
      await repo.upsertEntry(entry("room:ab", "k"));
      expect(await repo.deleteNamespacesLikeBatch("room:a:%", 2)).toBe(2);
      expect(await repo.deleteNamespacesLikeBatch("room:a:%", 2)).toBe(1);
      expect(await repo.deleteNamespacesLikeBatch("room:a:%", 2)).toBe(0);
      expect(await repo.findEntry("room:ab", "k")).not.toBeNull();
    });

    test("live lists: key ranges, JSON field filters, paging, counts", async () => {
      await repo.upsertEntry(entry("l", "a1"));
      await repo.upsertEntry(entry("l", "a2", { value: '{"kind":"b","n":2}' }));
      await repo.upsertEntry(entry("l", "a3", { value: "not json" }));
      await repo.upsertEntry(entry("l", "a4", { expires_at: 1 }));
      await repo.upsertEntry(entry("l", "b1"));
      const list = (
        range: object,
        json: { path: string; value: string | number | boolean }[] = [],
        offset = 0,
      ) =>
        repo
          .listLiveEntries("l", { nowMs: 10, range, jsonFieldEquals: json, limit: 10, offset })
          .then((rows) => rows.map((r) => r.key));
      expect(await list({})).toEqual(["a1", "a2", "a3", "b1"]);
      expect(await list({ from: "a", before: "b" })).toEqual(["a1", "a2", "a3"]);
      expect(await list({ after: "a1", through: "a3" })).toEqual(["a2", "a3"]);
      expect(await list({}, [{ path: '$."kind"', value: "a" }])).toEqual(["a1", "b1"]);
      expect(
        await list(
          {},
          [
            { path: '$."kind"', value: "a" },
            { path: '$."n"', value: 1 },
          ],
          1,
        ),
      ).toEqual(["b1"]);
      expect(await repo.countLiveEntries("l", 10, {})).toBe(4);
      expect(await repo.countLiveEntries("l", 10, { from: "b" })).toBe(1);
    });
  });
}
