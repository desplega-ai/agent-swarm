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

    test("asset key mappings, history and the cross-entity summary", async () => {
      const mapping = {
        id: "m1",
        provider_id: "agent-fs",
        provider_org_id: "",
        provider_drive_id: "d",
        provider_key: "/a.md",
        key: "shared/x/",
        source_entity_type: "external",
        source_entity_id: null,
        created_at: "2026-11-21T10:00:00.000Z",
        updated_at: "2026-11-21T10:00:00.000Z",
        created_by: null,
        updated_by: null,
      };
      expect(await repo.insertAssetKeyMapping(mapping)).toEqual(mapping);
      expect(
        (
          await repo.findAssetKeyMappingByProvider({
            providerId: "agent-fs",
            providerOrgId: "",
            providerDriveId: "d",
            providerKey: "/a.md",
          })
        )?.id,
      ).toBe("m1");
      const updated = await repo.updateAssetKeyMapping("m1", {
        key: "shared/y/",
        source_entity_type: "external",
        source_entity_id: "s",
        updated_at: "2026-11-21T11:00:00.000Z",
        updated_by: null,
      });
      expect([updated?.key, updated?.source_entity_id]).toEqual(["shared/y/", "s"]);
      await repo.insertAssetKeyHistory({
        id: "h1",
        entity_type: "file",
        entity_id: "m1",
        previous_key: "shared/x/",
        new_key: "shared/y/",
        changed_by: null,
      });
      expect(await repo.findAssetKey("file", "m1")).toBe("shared/y/");
      await repo.setAssetKey("file", "m1", {
        key: "shared/z/",
        now: "2026-11-21T12:00:00.000Z",
        changedBy: null,
        changedByAgentId: null,
      });
      expect((await repo.findAssetKeyMapping("m1"))?.updated_at).toBe("2026-11-21T12:00:00.000Z");
      await storage.executor.run(sql`
        INSERT INTO agent_tasks (id, "key", task, status, "createdAt", "lastUpdatedAt")
        VALUES ('t1234567890', 'shared/z/', 't', 'pending', '2026-11-21T09:00:00.000Z', '2026-11-21T13:00:00.000Z')`);
      const rows = await repo.listAssetSummaries(["task", "file"], "shared/z/%", 10);
      expect(rows.map((r) => [r.entityType, r.id, r.label, r.providerOrgId])).toEqual([
        ["task", "t1234567890", "Task t1234567", null],
        ["file", "m1", "/a.md", null],
      ]);
      expect(await repo.listAssetSummaries([], null, 10)).toEqual([]);
      expect(await repo.findAssetKey("task", "t1234567890")).toBe("shared/z/");
      expect(await repo.findAssetKey("page", "nope")).toBeNull();
    });
  });
}
