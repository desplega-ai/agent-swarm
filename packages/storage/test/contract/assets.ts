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

    test("listUserCreatedKeys: distinct keys of the user's resources, newest first, key ties, limit", async () => {
      const T0 = "2026-11-21T10:00:00.000Z";
      const T1 = "2026-11-21T11:00:00.000Z";
      await storage.executor.run(
        sql`INSERT INTO users (id, name) VALUES ('ct-u1', 'One'), ('ct-u2', 'Two')`,
      );
      await storage.executor.run(sql`
        INSERT INTO scheduled_tasks (id, name, "intervalMs", "taskTemplate", "createdAt", "lastUpdatedAt", "key", created_by)
        VALUES ('s1', 's1', 60000, 't', ${T0}, ${T0}, 'shared/b/', 'ct-u1'),
               ('s2', 's2', 60000, 't', ${T0}, ${T0}, 'shared/other/', 'ct-u2')`);
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, triggers, enabled, "createdAt", "lastUpdatedAt", "key", created_by)
        VALUES ('w1', 'w1', '{"nodes":[]}', '[]', ${true}, ${T1}, ${T1}, 'shared/b/', 'ct-u1'),
               ('w2', 'w2', '{"nodes":[]}', '[]', ${true}, ${T0}, ${T0}, 'shared/a/', 'ct-u1')`);
      // shared/b/ has the newest row (T1); shared/a/ and shared/c/ tie at T0 and sort by key.
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, triggers, enabled, "createdAt", "lastUpdatedAt", "key", created_by)
        VALUES ('w3', 'w3', '{"nodes":[]}', '[]', ${true}, ${T0}, ${T0}, 'shared/c/', 'ct-u1')`);
      expect(await repo.listUserCreatedKeys("ct-u1", 10)).toEqual([
        "shared/b/",
        "shared/a/",
        "shared/c/",
      ]);
      expect(await repo.listUserCreatedKeys("ct-u1", 2)).toEqual(["shared/b/", "shared/a/"]);
      expect(await repo.listUserCreatedKeys("nobody", 10)).toEqual([]);
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
      // Every kind at once: the arms mix timestamp and text columns.
      const all = await repo.listAssetSummaries(
        ["task", "workflow", "schedule", "page", "app", "script", "file"],
        "shared/z/%",
        10,
      );
      expect(all.map((r) => [r.entityType, r.updatedAt])).toEqual([
        ["task", "2026-11-21T13:00:00.000Z"],
        ["file", "2026-11-21T12:00:00.000Z"],
      ]);
      expect(await repo.findAssetKey("task", "t1234567890")).toBe("shared/z/");
      expect(await repo.findAssetKey("page", "nope")).toBeNull();
    });
  });
}
