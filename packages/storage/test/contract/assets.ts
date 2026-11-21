import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssetsRepository, Storage } from "../../src";
import { ASSET_KEY_TABLES, sql } from "../../src";
import type { ContractEngine } from "./env";

export function assetsContract(engine: ContractEngine): void {
  describe(`assets repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: AssetsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.assets;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("existingUserIds returns only ids of existing users, across chunks and duplicates", async () => {
      const ids = Array.from({ length: 1_200 }, (_, i) => `ct-missing-${i}`);
      await storage.executor.run(
        sql`INSERT INTO users (id, name) VALUES ('ct-u1', 'One'), ('ct-u2', 'Two')`,
      );
      const found = await repo.existingUserIds([...ids, "ct-u2", "ct-u1", "ct-u2"]);
      expect([...found].sort()).toEqual(["ct-u1", "ct-u2"]);
      expect((await repo.existingUserIds([])).size).toBe(0);
    });

    test("audit data lists every keyed table in order, rows in insertion order", async () => {
      const data = await repo.readAssetKeyAuditData();
      expect(data.keyRows.map((entry) => entry.table)).toEqual([...ASSET_KEY_TABLES]);
      for (const entry of data.keyRows) {
        for (const row of entry.rows) expect(Object.keys(row).sort()).toEqual(["id", "key"]);
      }
      expect(Array.isArray(data.attachmentMappings)).toBe(true);
      expect(Array.isArray(data.sourcedMappings)).toBe(true);
    });

    test("import items: ownership lookup and upsert keeps createdAt", async () => {
      expect(await repo.findImportedEntityId("src", "skill", "k1")).toBeNull();
      expect(await repo.isImportedEntity("skill", "e1")).toBe(false);
      await repo.upsertImportItem({
        sourceId: "src",
        kind: "skill",
        itemKey: "k1",
        entityId: "e1",
        now: "2026-11-21T10:00:00.000Z",
      });
      expect(await repo.findImportedEntityId("src", "skill", "k1")).toBe("e1");
      expect(await repo.isImportedEntity("skill", "e1")).toBe(true);
      expect(await repo.isImportedEntity("workflow", "e1")).toBe(false);
      await repo.upsertImportItem({
        sourceId: "src",
        kind: "skill",
        itemKey: "k1",
        entityId: "e2",
        now: "2026-11-21T11:00:00.000Z",
      });
      expect(await repo.findImportedEntityId("src", "skill", "k1")).toBe("e2");
      expect(await repo.isImportedEntity("skill", "e1")).toBe(false);
      const row = await storage.executor.get<{ createdAt: string; updatedAt: string }>(
        sql`SELECT "createdAt", "updatedAt" FROM import_items WHERE "itemKey" = 'k1'`,
      );
      expect(row).toEqual({
        createdAt: "2026-11-21T10:00:00.000Z",
        updatedAt: "2026-11-21T11:00:00.000Z",
      });
    });

    test("pending assignments: listed by agent id or name in insertion order, deleted per row and per source", async () => {
      const pending = (sourceId: string, agentKey: string, by: { id?: string; name?: string }) =>
        repo.insertPendingAssignment({
          sourceId,
          agentKey,
          agentId: by.id ?? null,
          agentName: by.name ?? null,
          instructions: agentKey === "b" ? "hi" : null,
          instructionsHash: agentKey === "b" ? "h" : null,
          skillKeys: '["s1"]',
          now: "2026-11-21T10:00:00.000Z",
        });
      await pending("s2", "z", { name: "Ann" });
      await pending("s1", "b", { id: "a1" });
      await pending("s1", "a", { name: "Bob" });
      expect(await repo.listPendingAssignmentsForAgent("a1", "Ann")).toEqual([
        {
          sourceId: "s2",
          agentKey: "z",
          instructions: null,
          instructionsHash: null,
          skillKeys: '["s1"]',
        },
        {
          sourceId: "s1",
          agentKey: "b",
          instructions: "hi",
          instructionsHash: "h",
          skillKeys: '["s1"]',
        },
      ]);
      await repo.deletePendingAssignment("s2", "z");
      expect(
        (await repo.listPendingAssignmentsForAgent("a1", "Ann")).map((r) => r.agentKey),
      ).toEqual(["b"]);
      await repo.deletePendingAssignmentsBySource("s1");
      expect(await repo.listPendingAssignmentsForAgent("a1", "Bob")).toEqual([]);
    });
  });
}
