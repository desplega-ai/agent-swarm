import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type McpServersRepository,
  type NewMcpEventSubscription,
  type Storage,
  sql,
} from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function newSubscription(
  overrides: Partial<NewMcpEventSubscription> = {},
): NewMcpEventSubscription {
  return {
    id: overrides.id ?? `sub_${crypto.randomUUID()}`,
    userId: "u1",
    tokenId: "tok1",
    eventName: "task.completed",
    argumentsJson: "{}",
    url: "https://hook.example/a",
    secretSealed: "sealed-1",
    verifiedAt: T0,
    expiresAt: T2,
    now: T0,
    ...overrides,
  };
}

export function mcpServersContract(engine: ContractEngine): void {
  describe(`mcpServers repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: McpServersRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.mcpServers;
      // The subscriptions reference a user and a token.
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U')`);
      await storage.executor.run(
        sql`INSERT INTO user_tokens (id, "userId", "tokenHash", "tokenPreview") VALUES ('tok1', 'u1', 'h1', 'p1'), ('tok2', 'u1', 'h2', 'p2')`,
      );
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("insertSubscription stores the stored value shape", async () => {
      await repo.insertSubscription(newSubscription({ id: "s1" }));
      expect(await repo.findSubscription("s1")).toMatchObject({
        id: "s1",
        userId: "u1",
        tokenId: "tok1",
        secretSealed: "sealed-1",
        previousSecretSealed: null,
        previousSecretUntil: null,
        verifiedAt: T0,
        expiresAt: T2,
        lastDeliveryAt: null,
        lastError: null,
        failedSince: null,
        createdAt: T0,
        updatedAt: T0,
      });
      expect(await repo.findSubscription("missing")).toBeNull();
    });

    test("live counts, exclusion and the latest verification", async () => {
      await repo.insertSubscription(newSubscription({ id: "s1", verifiedAt: T0 }));
      await repo.insertSubscription(
        newSubscription({ id: "s2", url: "https://hook.example/b", verifiedAt: T1 }),
      );
      await repo.insertSubscription(newSubscription({ id: "s3", expiresAt: T1, verifiedAt: T1 }));
      expect(await repo.countLiveSubscriptions("u1", T0)).toBe(3);
      expect(await repo.countLiveSubscriptions("u1", T1)).toBe(2);
      expect(await repo.countLiveSubscriptions("u1", T1, "s1")).toBe(1);
      expect(await repo.countLiveSubscriptions("nobody", T0)).toBe(0);
      // Callers pass an ISO lower bound (verifiedAt is timestamptz on Postgres).
      const SINCE = "2000-01-01T00:00:00.000Z";
      expect(await repo.latestVerification("u1", "https://hook.example/a", SINCE, T0)).toBe(T1);
      expect(await repo.latestVerification("u1", "https://hook.example/a", SINCE, T1)).toBe(T0);
      expect(await repo.latestVerification("u1", "https://hook.example/a", T0, T1)).toBeNull();
      expect(await repo.deleteExpiredSubscriptions(T1)).toBe(1);
      expect(await repo.findSubscription("s3")).toBeNull();
    });

    test("renew and delete are scoped to the row and user", async () => {
      await repo.insertSubscription(newSubscription({ id: "s1" }));
      await repo.renewSubscription("s1", {
        tokenId: "tok2",
        secretSealed: "sealed-2",
        previousSecretSealed: "sealed-1",
        previousSecretUntil: T1,
        verifiedAt: T1,
        expiresAt: "2026-11-22T10:00:00.000Z",
        now: T1,
        actor: "u1",
      });
      expect(await repo.findSubscription("s1")).toMatchObject({
        tokenId: "tok2",
        secretSealed: "sealed-2",
        previousSecretSealed: "sealed-1",
        previousSecretUntil: T1,
        updatedAt: T1,
        createdAt: T0,
      });
      expect(await repo.deleteSubscription("s1", "other")).toBe(false);
      expect(await repo.deleteSubscription("s1", "u1")).toBe(true);
      expect(await repo.deleteSubscription("s1", "u1")).toBe(false);
    });

    test("listLiveSubscriptions orders by expiresAt, then insertion", async () => {
      await repo.insertSubscription(newSubscription({ id: "z", expiresAt: T2 }));
      await repo.insertSubscription(newSubscription({ id: "a", expiresAt: T2 }));
      await repo.insertSubscription(newSubscription({ id: "m", expiresAt: T1 }));
      await repo.insertSubscription(newSubscription({ id: "x", eventName: "other" }));
      await repo.insertSubscription(newSubscription({ id: "old", expiresAt: T0 }));
      const rows = await repo.listLiveSubscriptions("u1", "task.completed", T0);
      expect(rows.map((row) => row.id)).toEqual(["m", "z", "a"]);
    });

    test("delivery outcomes keep the first failure time", async () => {
      await repo.insertSubscription(newSubscription({ id: "s1" }));
      await repo.recordDeliveryFailure("s1", "timeout", T0);
      await repo.recordDeliveryFailure("s1", "http_5xx", T1);
      expect(await repo.findSubscription("s1")).toMatchObject({
        lastError: "http_5xx",
        failedSince: T0,
        lastDeliveryAt: null,
      });
      await repo.recordDeliverySuccess("s1", T2);
      expect(await repo.findSubscription("s1")).toMatchObject({
        lastError: null,
        failedSince: null,
        lastDeliveryAt: T2,
      });
    });

    test("authMethod reads and writes stamp lastUpdatedAt", async () => {
      await storage.executor.run(sql`
        INSERT INTO mcp_servers (id, name, scope, transport, "createdAt", "lastUpdatedAt")
        VALUES ('srv', 'srv', 'global', 'http', ${T0}, ${T0})`);
      expect(await repo.getAuthMethod("srv")).toBe("static");
      expect(await repo.getAuthMethod("missing")).toBeNull();
      await repo.setAuthMethod("srv", "oauth");
      expect(await repo.getAuthMethod("srv")).toBe("oauth");
      const row = await storage.executor.get<{ lastUpdatedAt: string }>(
        sql`SELECT "lastUpdatedAt" FROM mcp_servers WHERE id = 'srv'`,
      );
      expect(row?.lastUpdatedAt).not.toBe(T0);
      expect(row?.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    const server = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      description: null,
      scope: "agent",
      ownerAgentId: null,
      transport: "stdio",
      command: "run",
      args: null,
      url: null,
      headers: null,
      envConfigKeys: null,
      headerConfigKeys: null,
      extraAuthorizeParams: null,
      createdAt: "2026-11-21T10:00:00.000Z",
      lastUpdatedAt: "2026-11-21T10:00:00.000Z",
      ...extra,
    });

    test("MCP server CRUD: version bumps on config, lists, cascade delete", async () => {
      const before = await repo.countMcpServers();
      expect(await repo.insertMcpServer(server("zb"))).toMatchObject({
        isEnabled: 1,
        version: 1,
        authMethod: "static",
      });
      await repo.insertMcpServer(server("za", { scope: "swarm", description: "Find THINGS" }));
      expect(await repo.countMcpServers()).toBe(before + 2);
      const named = await repo.updateMcpServer(
        "zb",
        { description: "d", isEnabled: false },
        "2026-11-21T11:00:00.000Z",
      );
      expect([named?.version, named?.isEnabled, named?.lastUpdatedAt]).toEqual([
        1,
        0,
        "2026-11-21T11:00:00.000Z",
      ]);
      expect(
        (await repo.updateMcpServer("zb", { url: null }, "2026-11-21T12:00:00.000Z"))?.version,
      ).toBe(2);
      expect((await repo.findMcpServerByName("za", "swarm", ""))?.id).toBe("za");
      const ids = async (f: object) =>
        (await repo.listMcpServers(f)).map((r) => r.id).filter((id) => id.startsWith("z"));
      expect(await ids({})).toEqual(["za", "zb"]);
      expect(await ids({ isEnabled: true })).toEqual(["za"]);
      expect(await ids({ search: "things" })).toEqual(["za"]);
      await storage.executor.run(sql`
        INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
        VALUES ('ag', 'ag', 'idle', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z')`);
      await storage.executor.run(sql`
        INSERT INTO agent_mcp_servers (id, "agentId", "mcpServerId", "isActive", "installedAt")
        VALUES ('i1', 'ag', 'za', ${true}, '2026-11-21T10:00:00.000Z'), ('i2', 'ag', 'zb', ${true}, '2026-11-21T11:00:00.000Z')`);
      expect((await repo.listAgentMcpServers("ag", true)).map((r) => [r.id, r.isActive])).toEqual([
        ["za", 1],
      ]);
      await repo.updateMcpServer("zb", { isEnabled: true }, "2026-11-21T12:00:00.000Z");
      expect((await repo.listAgentMcpServers("ag", false)).map((r) => r.id)).toEqual(["za", "zb"]);
      expect(await repo.deleteMcpServerCascade("zb")).toEqual({ servers: 1, scriptConnections: 0 });
      expect(await repo.findMcpServerById("zb")).toBeNull();
    });
  });
}
