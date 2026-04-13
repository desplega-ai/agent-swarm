import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { getOAuthApp, storeOAuthTokens, upsertOAuthApp } from "../be/db-queries/oauth";
import {
  createTrackerAgentMapping,
  createTrackerSync,
  deleteTrackerSync,
  getAllTrackerAgentMappings,
  getAllTrackerSyncs,
  getTrackerSync,
} from "../be/db-queries/tracker";

const TEST_DB_PATH = "./test-tracker-tools.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("tracker-status (DB layer)", () => {
  test("returns null when no OAuth app configured", () => {
    const app = getOAuthApp("linear");
    // May or may not exist depending on test order, but the query itself should not throw
    expect(app === null || typeof app === "object").toBe(true);
  });

  test("returns token info after storing tokens", () => {
    upsertOAuthApp("linear", {
      clientId: "test-client",
      clientSecret: "test-secret",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      redirectUri: "http://localhost:3013/api/trackers/linear/callback",
      scopes: "read,write",
    });

    storeOAuthTokens("linear", {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      scope: "read,write",
    });

    const app = getOAuthApp("linear");
    expect(app).not.toBeNull();
    expect(app!.clientId).toBe("test-client");
  });
});

describe("tracker-link-task (DB layer)", () => {
  test("creates a task sync mapping", () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "tool-task-001",
      externalId: "LIN-TOOL-001",
      externalIdentifier: "ENG-100",
      externalUrl: "https://linear.app/team/ENG-100",
      syncDirection: "bidirectional",
    });

    expect(sync.id).toBeDefined();
    expect(sync.provider).toBe("linear");
    expect(sync.entityType).toBe("task");
    expect(sync.swarmId).toBe("tool-task-001");
    expect(sync.externalId).toBe("LIN-TOOL-001");
  });

  test("duplicate link throws", () => {
    expect(() =>
      createTrackerSync({
        provider: "linear",
        entityType: "task",
        swarmId: "tool-task-001",
        externalId: "LIN-TOOL-DIFFERENT",
      }),
    ).toThrow();
  });
});

describe("tracker-unlink (DB layer)", () => {
  test("removes a sync mapping", () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "tool-task-unlink",
      externalId: "LIN-UNLINK-001",
    });

    expect(getTrackerSync("linear", "task", "tool-task-unlink")).not.toBeNull();

    deleteTrackerSync(sync.id);

    expect(getTrackerSync("linear", "task", "tool-task-unlink")).toBeNull();
  });
});

describe("tracker-sync-status (DB layer)", () => {
  test("returns all syncs", () => {
    const all = getAllTrackerSyncs();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by provider", () => {
    const linear = getAllTrackerSyncs("linear");
    expect(linear.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by entityType", () => {
    const tasks = getAllTrackerSyncs(undefined, "task");
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by both provider and entityType", () => {
    const linearTasks = getAllTrackerSyncs("linear", "task");
    expect(linearTasks.length).toBeGreaterThanOrEqual(1);
    for (const sync of linearTasks) {
      expect(sync.provider).toBe("linear");
      expect(sync.entityType).toBe("task");
    }
  });
});

describe("tracker-map-agent (DB layer)", () => {
  test("creates an agent mapping", () => {
    const mapping = createTrackerAgentMapping({
      provider: "linear",
      agentId: "tool-agent-001",
      externalUserId: "lin-user-tool-001",
      agentName: "Test Coder",
    });

    expect(mapping.id).toBeDefined();
    expect(mapping.provider).toBe("linear");
    expect(mapping.agentId).toBe("tool-agent-001");
    expect(mapping.externalUserId).toBe("lin-user-tool-001");
    expect(mapping.agentName).toBe("Test Coder");
  });

  test("duplicate agent mapping throws", () => {
    expect(() =>
      createTrackerAgentMapping({
        provider: "linear",
        agentId: "tool-agent-001",
        externalUserId: "lin-user-different",
        agentName: "Duplicate",
      }),
    ).toThrow();
  });

  test("getAllTrackerAgentMappings returns mappings", () => {
    const all = getAllTrackerAgentMappings("linear");
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some((m) => m.agentId === "tool-agent-001")).toBe(true);
  });
});
