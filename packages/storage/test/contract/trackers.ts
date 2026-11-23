import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type NewTrackerSync, type Storage, sql, type TrackersRepository } from "../../src";
import type { ContractEngine } from "./env";

function newSync(overrides: Partial<NewTrackerSync> = {}): NewTrackerSync {
  return {
    provider: "linear",
    entityType: "task",
    providerEntityType: null,
    swarmId: crypto.randomUUID(),
    externalId: crypto.randomUUID(),
    externalIdentifier: null,
    externalUrl: null,
    lastSyncOrigin: null,
    lastDeliveryId: null,
    syncDirection: "inbound",
    ...overrides,
  };
}

const SQLITE_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function trackersContract(engine: ContractEngine): void {
  describe(`trackers repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: TrackersRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.trackers;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("insertSync returns the row with the column defaults", async () => {
      const row = await repo.insertSync(
        newSync({ swarmId: "s1", externalId: "e1", externalIdentifier: "ENG-1" }),
      );
      expect(row).toMatchObject({
        provider: "linear",
        entityType: "task",
        swarmId: "s1",
        externalId: "e1",
        externalIdentifier: "ENG-1",
        lastSyncOrigin: null,
        syncDirection: "inbound",
      });
      expect(row.id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.createdAt).toMatch(SQLITE_TEXT);
      expect(row.lastSyncedAt).toMatch(SQLITE_TEXT);
      expect(await repo.findSync("linear", "task", "s1")).toEqual(row);
      expect(await repo.findSyncByExternalId("linear", "task", "e1")).toEqual(row);
      expect(await repo.findSync("jira", "task", "s1")).toBeNull();
    });

    test("insertSyncIfAbsent gives null on an existing external id", async () => {
      const first = await repo.insertSyncIfAbsent(newSync({ externalId: "e1", swarmId: "a" }));
      expect(first?.swarmId).toBe("a");
      expect(await repo.insertSyncIfAbsent(newSync({ externalId: "e1", swarmId: "b" }))).toBeNull();
      expect((await repo.findSyncByExternalId("linear", "task", "e1"))?.swarmId).toBe("a");
    });

    test("swarm id moves, partial updates, deliveries and delete", async () => {
      const a = await repo.insertSync(newSync({ swarmId: "old", externalId: "e1" }));
      await repo.insertSync(newSync({ provider: "jira", swarmId: "old", externalId: "e2" }));
      expect(await repo.repointSyncSwarmId("old", "new")).toBe(2);
      expect(await repo.repointSyncSwarmId("old", "new")).toBe(0);
      await repo.setSyncSwarmId(a.id, "mine");
      await repo.updateSync(a.id, { externalUrl: "https://x", lastSyncOrigin: "swarm" });
      await repo.updateSync(a.id, {});
      expect(await repo.findSync("linear", "task", "mine")).toMatchObject({
        externalUrl: "https://x",
        lastSyncOrigin: "swarm",
        externalIdentifier: null,
      });
      expect(await repo.hasDelivery("linear", "d1")).toBe(false);
      await repo.markDelivery("linear", "task", "e1", "d1");
      expect(await repo.hasDelivery("linear", "d1")).toBe(true);
      expect(await repo.hasDelivery("jira", "d1")).toBe(false);
      expect(await repo.deleteSync(a.id)).toBe(true);
      expect(await repo.deleteSync(a.id)).toBe(false);
    });

    test("listSyncs orders by createdAt descending, then insertion", async () => {
      const add = async (externalId: string, provider: string, createdAt: string) => {
        await repo.insertSync(newSync({ externalId, provider }));
        await storage.executor.run(
          sql`UPDATE tracker_sync SET "createdAt" = ${createdAt} WHERE "externalId" = ${externalId}`,
        );
      };
      await add("z", "linear", "2026-01-01 00:00:00");
      await add("a", "jira", "2026-01-01 00:00:00");
      await add("m", "linear", "2026-01-02 00:00:00");
      await add("b", "linear", "2026-01-01 00:00:00");
      const ids = async (filters: { provider?: string; entityType?: string }) =>
        (await repo.listSyncs(filters)).map((row) => row.externalId);
      expect(await ids({})).toEqual(["m", "z", "a", "b"]);
      expect(await ids({ provider: "linear" })).toEqual(["m", "z", "b"]);
      expect(await ids({ provider: "linear", entityType: "task" })).toEqual(["m", "z", "b"]);
    });

    test("agent mappings: insert, lookups, order with ties, delete", async () => {
      const row = await repo.insertAgentMapping({
        provider: "linear",
        agentId: "ag1",
        externalUserId: "x1",
        agentName: "Alpha",
      });
      expect(row).toMatchObject({ provider: "linear", agentId: "ag1", agentName: "Alpha" });
      expect(row.createdAt).toMatch(SQLITE_TEXT);
      expect(await repo.findAgentMapping("linear", "ag1")).toEqual(row);
      expect(await repo.findAgentMappingByExternalUser("linear", "x1")).toEqual(row);
      await repo.insertAgentMapping({
        provider: "jira",
        agentId: "ag2",
        externalUserId: "x2",
        agentName: "B",
      });
      await repo.insertAgentMapping({
        provider: "linear",
        agentId: "ag3",
        externalUserId: "x3",
        agentName: "C",
      });
      await storage.executor.run(
        sql`UPDATE tracker_agent_mapping SET "createdAt" = '2026-01-01 00:00:00'`,
      );
      expect((await repo.listAgentMappings()).map((r) => r.agentId)).toEqual(["ag1", "ag2", "ag3"]);
      expect((await repo.listAgentMappings("linear")).map((r) => r.agentId)).toEqual([
        "ag1",
        "ag3",
      ]);
      await repo.deleteAgentMapping("linear", "ag1");
      expect(await repo.findAgentMapping("linear", "ag1")).toBeNull();
    });
  });
}
