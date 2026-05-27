import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  createTrackerAgentMapping,
  createTrackerSync,
  deleteTrackerAgentMapping,
  deleteTrackerSync,
  getAllTrackerAgentMappings,
  getAllTrackerSyncs,
  getTrackerAgentMapping,
  getTrackerAgentMappingByExternalUser,
  getTrackerSync,
  getTrackerSyncByExternalId,
  updateTrackerSync,
} from "../be/db-queries/tracker";

const TEST_DB_PATH = "./test-db-queries-tracker.sqlite";

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("Tracker Sync CRUD", () => {
  test("getTrackerSync returns null for unknown mapping", async () => {
    expect(await getTrackerSync("linear", "task", "nonexistent")).toBeNull();
  });

  test("createTrackerSync creates a mapping", async () => {
    const sync = await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "task-001",
      externalId: "LIN-123",
      externalIdentifier: "ENG-42",
      externalUrl: "https://linear.app/team/ENG-42",
      syncDirection: "inbound",
    });

    expect(sync.id).toBeDefined();
    expect(sync.provider).toBe("linear");
    expect(sync.entityType).toBe("task");
    expect(sync.swarmId).toBe("task-001");
    expect(sync.externalId).toBe("LIN-123");
    expect(sync.externalIdentifier).toBe("ENG-42");
    expect(sync.externalUrl).toBe("https://linear.app/team/ENG-42");
    expect(sync.syncDirection).toBe("inbound");
    expect(sync.lastSyncOrigin).toBeNull();
  });

  test("getTrackerSync retrieves by swarmId", async () => {
    const sync = await getTrackerSync("linear", "task", "task-001");
    expect(sync).not.toBeNull();
    expect(sync!.externalId).toBe("LIN-123");
  });

  test("getTrackerSyncByExternalId retrieves by externalId", async () => {
    const sync = await getTrackerSyncByExternalId("linear", "task", "LIN-123");
    expect(sync).not.toBeNull();
    expect(sync!.swarmId).toBe("task-001");
  });

  test("updateTrackerSync updates fields", async () => {
    const sync = await getTrackerSync("linear", "task", "task-001")!;
    await updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastDeliveryId: "delivery-abc",
      syncDirection: "bidirectional",
    });

    const updated = await getTrackerSync("linear", "task", "task-001")!;
    expect(updated.lastSyncOrigin).toBe("external");
    expect(updated.lastDeliveryId).toBe("delivery-abc");
    expect(updated.syncDirection).toBe("bidirectional");
  });

  test("createTrackerSync enforces unique(provider, entityType, swarmId)", () => {
    expect(
      async () =>
        await createTrackerSync({
          provider: "linear",
          entityType: "task",
          swarmId: "task-001",
          externalId: "LIN-999",
        }),
    ).toThrow();
  });

  test("createTrackerSync enforces unique(provider, entityType, externalId)", () => {
    expect(
      async () =>
        await createTrackerSync({
          provider: "linear",
          entityType: "task",
          swarmId: "task-999",
          externalId: "LIN-123",
        }),
    ).toThrow();
  });

  test("same swarmId allowed for different providers", async () => {
    const jiraSync = await createTrackerSync({
      provider: "jira" as "linear", // cast for test — DB doesn't constrain provider values
      entityType: "task",
      swarmId: "task-001",
      externalId: "JIRA-456",
    });
    expect(jiraSync.provider).toBe("jira");
  });

  test("getAllTrackerSyncs returns all", async () => {
    const all = await getAllTrackerSyncs();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("getAllTrackerSyncs filters by provider", async () => {
    const linear = await getAllTrackerSyncs("linear");
    const jira = await getAllTrackerSyncs("jira");
    expect(linear.length).toBeGreaterThanOrEqual(1);
    expect(jira.length).toBe(1);
  });

  test("getAllTrackerSyncs filters by entityType", async () => {
    const tasks = await getAllTrackerSyncs(undefined, "task");
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  test("deleteTrackerSync removes the mapping", async () => {
    const sync = await getTrackerSyncByExternalId("jira", "task", "JIRA-456")!;
    await deleteTrackerSync(sync.id);
    expect(await getTrackerSyncByExternalId("jira", "task", "JIRA-456")).toBeNull();
  });
});

describe("Tracker Agent Mapping CRUD", () => {
  test("getTrackerAgentMapping returns null for unknown", async () => {
    expect(await getTrackerAgentMapping("linear", "nonexistent")).toBeNull();
  });

  test("createTrackerAgentMapping creates a mapping", async () => {
    const mapping = await createTrackerAgentMapping({
      provider: "linear",
      agentId: "agent-001",
      externalUserId: "lin-user-abc",
      agentName: "Coder Agent",
    });

    expect(mapping.id).toBeDefined();
    expect(mapping.provider).toBe("linear");
    expect(mapping.agentId).toBe("agent-001");
    expect(mapping.externalUserId).toBe("lin-user-abc");
    expect(mapping.agentName).toBe("Coder Agent");
  });

  test("getTrackerAgentMapping retrieves by agentId", async () => {
    const mapping = await getTrackerAgentMapping("linear", "agent-001");
    expect(mapping).not.toBeNull();
    expect(mapping!.externalUserId).toBe("lin-user-abc");
  });

  test("getTrackerAgentMappingByExternalUser retrieves by externalUserId", async () => {
    const mapping = await getTrackerAgentMappingByExternalUser("linear", "lin-user-abc");
    expect(mapping).not.toBeNull();
    expect(mapping!.agentId).toBe("agent-001");
  });

  test("enforces unique(provider, agentId)", () => {
    expect(
      async () =>
        await createTrackerAgentMapping({
          provider: "linear",
          agentId: "agent-001",
          externalUserId: "lin-user-xyz",
          agentName: "Duplicate",
        }),
    ).toThrow();
  });

  test("enforces unique(provider, externalUserId)", () => {
    expect(
      async () =>
        await createTrackerAgentMapping({
          provider: "linear",
          agentId: "agent-002",
          externalUserId: "lin-user-abc",
          agentName: "Duplicate",
        }),
    ).toThrow();
  });

  test("same agentId allowed for different providers", async () => {
    const jiraMapping = await createTrackerAgentMapping({
      provider: "jira" as "linear",
      agentId: "agent-001",
      externalUserId: "jira-user-abc",
      agentName: "Coder Agent",
    });
    expect(jiraMapping.provider).toBe("jira");
  });

  test("getAllTrackerAgentMappings returns all", async () => {
    const all = await getAllTrackerAgentMappings();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("getAllTrackerAgentMappings filters by provider", async () => {
    const linear = await getAllTrackerAgentMappings("linear");
    expect(linear.length).toBe(1);
  });

  test("deleteTrackerAgentMapping removes the mapping", async () => {
    await deleteTrackerAgentMapping("jira", "agent-001");
    expect(await getTrackerAgentMapping("jira", "agent-001")).toBeNull();
  });
});
