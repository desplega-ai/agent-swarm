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

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("Tracker Sync CRUD", () => {
  test("getTrackerSync returns null for unknown mapping", () => {
    expect(getTrackerSync("linear", "task", "nonexistent")).toBeNull();
  });

  test("createTrackerSync creates a mapping", () => {
    const sync = createTrackerSync({
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

  test("getTrackerSync retrieves by swarmId", () => {
    const sync = getTrackerSync("linear", "task", "task-001");
    expect(sync).not.toBeNull();
    expect(sync!.externalId).toBe("LIN-123");
  });

  test("getTrackerSyncByExternalId retrieves by externalId", () => {
    const sync = getTrackerSyncByExternalId("linear", "task", "LIN-123");
    expect(sync).not.toBeNull();
    expect(sync!.swarmId).toBe("task-001");
  });

  test("updateTrackerSync updates fields", () => {
    const sync = getTrackerSync("linear", "task", "task-001")!;
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastDeliveryId: "delivery-abc",
      syncDirection: "bidirectional",
    });

    const updated = getTrackerSync("linear", "task", "task-001")!;
    expect(updated.lastSyncOrigin).toBe("external");
    expect(updated.lastDeliveryId).toBe("delivery-abc");
    expect(updated.syncDirection).toBe("bidirectional");
  });

  test("createTrackerSync enforces unique(provider, entityType, swarmId)", () => {
    expect(() =>
      createTrackerSync({
        provider: "linear",
        entityType: "task",
        swarmId: "task-001",
        externalId: "LIN-999",
      }),
    ).toThrow();
  });

  test("createTrackerSync enforces unique(provider, entityType, externalId)", () => {
    expect(() =>
      createTrackerSync({
        provider: "linear",
        entityType: "task",
        swarmId: "task-999",
        externalId: "LIN-123",
      }),
    ).toThrow();
  });

  test("same externalId allowed for different entityTypes", () => {
    const epic = createTrackerSync({
      provider: "linear",
      entityType: "epic",
      swarmId: "epic-001",
      externalId: "LIN-123",
    });
    expect(epic.entityType).toBe("epic");
  });

  test("same swarmId allowed for different providers", () => {
    const jiraSync = createTrackerSync({
      provider: "jira" as "linear", // cast for test — DB doesn't constrain provider values
      entityType: "task",
      swarmId: "task-001",
      externalId: "JIRA-456",
    });
    expect(jiraSync.provider).toBe("jira");
  });

  test("getAllTrackerSyncs returns all", () => {
    const all = getAllTrackerSyncs();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test("getAllTrackerSyncs filters by provider", () => {
    const linear = getAllTrackerSyncs("linear");
    const jira = getAllTrackerSyncs("jira");
    expect(linear.length).toBeGreaterThanOrEqual(2);
    expect(jira.length).toBe(1);
  });

  test("getAllTrackerSyncs filters by entityType", () => {
    const tasks = getAllTrackerSyncs(undefined, "task");
    const epics = getAllTrackerSyncs(undefined, "epic");
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(epics.length).toBeGreaterThanOrEqual(1);
  });

  test("deleteTrackerSync removes the mapping", () => {
    const sync = getTrackerSyncByExternalId("jira", "task", "JIRA-456")!;
    deleteTrackerSync(sync.id);
    expect(getTrackerSyncByExternalId("jira", "task", "JIRA-456")).toBeNull();
  });
});

describe("Tracker Agent Mapping CRUD", () => {
  test("getTrackerAgentMapping returns null for unknown", () => {
    expect(getTrackerAgentMapping("linear", "nonexistent")).toBeNull();
  });

  test("createTrackerAgentMapping creates a mapping", () => {
    const mapping = createTrackerAgentMapping({
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

  test("getTrackerAgentMapping retrieves by agentId", () => {
    const mapping = getTrackerAgentMapping("linear", "agent-001");
    expect(mapping).not.toBeNull();
    expect(mapping!.externalUserId).toBe("lin-user-abc");
  });

  test("getTrackerAgentMappingByExternalUser retrieves by externalUserId", () => {
    const mapping = getTrackerAgentMappingByExternalUser("linear", "lin-user-abc");
    expect(mapping).not.toBeNull();
    expect(mapping!.agentId).toBe("agent-001");
  });

  test("enforces unique(provider, agentId)", () => {
    expect(() =>
      createTrackerAgentMapping({
        provider: "linear",
        agentId: "agent-001",
        externalUserId: "lin-user-xyz",
        agentName: "Duplicate",
      }),
    ).toThrow();
  });

  test("enforces unique(provider, externalUserId)", () => {
    expect(() =>
      createTrackerAgentMapping({
        provider: "linear",
        agentId: "agent-002",
        externalUserId: "lin-user-abc",
        agentName: "Duplicate",
      }),
    ).toThrow();
  });

  test("same agentId allowed for different providers", () => {
    const jiraMapping = createTrackerAgentMapping({
      provider: "jira" as "linear",
      agentId: "agent-001",
      externalUserId: "jira-user-abc",
      agentName: "Coder Agent",
    });
    expect(jiraMapping.provider).toBe("jira");
  });

  test("getAllTrackerAgentMappings returns all", () => {
    const all = getAllTrackerAgentMappings();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("getAllTrackerAgentMappings filters by provider", () => {
    const linear = getAllTrackerAgentMappings("linear");
    expect(linear.length).toBe(1);
  });

  test("deleteTrackerAgentMapping removes the mapping", () => {
    deleteTrackerAgentMapping("jira", "agent-001");
    expect(getTrackerAgentMapping("jira", "agent-001")).toBeNull();
  });
});
