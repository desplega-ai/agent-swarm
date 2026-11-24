import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KeyedTextTable, MaintenanceRepository, Storage } from "../../src";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

// kv_entries: TEXT key, unique within a namespace, so a namespace filter makes it a keyed table.
const KV: KeyedTextTable = {
  table: "kv_entries",
  idColumn: "key",
  whereEquals: { column: "namespace", value: "ct-ns" },
};

export function maintenanceContract(engine: ContractEngine): void {
  describe(`maintenance repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: MaintenanceRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.maintenance;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const putKv = (namespace: string, key: string, value: string) =>
      storage.executor.run(
        sql`INSERT INTO kv_entries (namespace, key, value, value_type) VALUES (${namespace}, ${key}, ${value}, 'string')`,
      );

    test("state upserts, reads back and stamps the engine time as YYYY-MM-DD HH:MM:SS", async () => {
      expect(await repo.getState("ct-key")).toBeNull();
      await repo.setState("ct-key", "a");
      await repo.setState("ct-key", "b");
      expect(await repo.getState("ct-key")).toBe("b");
      const row = await storage.executor.get<{ seededAt: string }>(
        sql`SELECT "seededAt" FROM seed_state WHERE kind = 'maintenance' AND key = 'ct-key'`,
      );
      expect(row?.seededAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    test("deleteStatesLike treats ! as the escape, so _ and % in the prefix are literal", async () => {
      await repo.setState("v_1:a:cursor", "x");
      await repo.setState("vx1:a:cursor", "x");
      await repo.setState("v_1:a:other", "x");
      await repo.deleteStatesLike("v!_1:%:cursor");
      expect(await repo.getState("v_1:a:cursor")).toBeNull();
      expect(await repo.getState("vx1:a:cursor")).toBe("x");
      expect(await repo.getState("v_1:a:other")).toBe("x");
    });

    test("deleteSkippedBootScrubVersions deletes versions up to and including N only", async () => {
      for (const v of [3, 9, 10, 11]) await repo.setState(`boot-scrub-skipped-v${v}`, "f");
      await repo.setState("boot-scrub-v3", "done");
      await repo.deleteSkippedBootScrubVersions(10);
      expect(await repo.getState("boot-scrub-skipped-v3")).toBeNull();
      expect(await repo.getState("boot-scrub-skipped-v9")).toBeNull();
      expect(await repo.getState("boot-scrub-skipped-v10")).toBeNull();
      expect(await repo.getState("boot-scrub-skipped-v11")).toBe("f");
      expect(await repo.getState("boot-scrub-v3")).toBe("done");
    });

    test("deleteSkippedBootScrubVersions reads leading digits only, as an integer", async () => {
      await repo.setState("boot-scrub-skipped-v5x", "f");
      await repo.setState("boot-scrub-skipped-vx", "f");
      await repo.setState("boot-scrub-skipped-v100", "f");
      await repo.setState("Boot-scrub-skipped-v1", "f");
      await repo.deleteSkippedBootScrubVersions(10);
      expect(await repo.getState("boot-scrub-skipped-v5x")).toBeNull();
      expect(await repo.getState("boot-scrub-skipped-vx")).toBeNull();
      expect(await repo.getState("boot-scrub-skipped-v100")).toBe("f");
      expect(await repo.getState("Boot-scrub-skipped-v1")).toBe("f");
    });

    test("scanKeyedBatch pages in key order after the cursor, inside the filter", async () => {
      for (const key of ["b", "a", "d", "c"]) await putKv("ct-ns", key, `v-${key}`);
      await putKv("other-ns", "aa", "x");
      const first = await repo.scanKeyedBatch(KV, ["value"], "", 2);
      expect(first).toEqual([
        { id: "a", value: "v-a" },
        { id: "b", value: "v-b" },
      ]);
      const next = await repo.scanKeyedBatch(KV, ["value"], "b", 10);
      expect(next.map((r) => r.id)).toEqual(["c", "d"]);
    });

    test("compareAndSetRow writes only while the expected values hold", async () => {
      await putKv("ct-ns", "k", "old");
      expect(await repo.compareAndSetRow(KV, "k", { value: "new" }, { value: "stale" }, [])).toBe(
        false,
      );
      expect(await repo.compareAndSetRow(KV, "k", { value: "new" }, { value: "old" }, [])).toBe(
        true,
      );
      // A NULL guard: expires_at is NULL, so the write lands; then it is not NULL.
      expect(
        await repo.compareAndSetRow(KV, "k", { expires_at: 5 }, { value: "new" }, ["expires_at"]),
      ).toBe(true);
      expect(
        await repo.compareAndSetRow(KV, "k", { expires_at: 6 }, { value: "new" }, ["expires_at"]),
      ).toBe(false);
      // A NULL expected value compares equal to NULL.
      await putKv("ct-ns", "n", "v");
      expect(
        await repo.compareAndSetRow(KV, "n", { value: "w" }, { value: "v", expires_at: null }, []),
      ).toBe(true);
      const rows = await repo.scanKeyedBatch(KV, ["value"], "", 10);
      expect(rows).toEqual([
        { id: "k", value: "new" },
        { id: "n", value: "w" },
      ]);
    });
  });
}
