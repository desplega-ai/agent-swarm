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
      expect(await repo.latestVerification("u1", "https://hook.example/a", "2000", T0)).toBe(T1);
      expect(await repo.latestVerification("u1", "https://hook.example/a", "2000", T1)).toBe(T0);
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
  });
}
