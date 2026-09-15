import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  acquireOAuthRefreshLock,
  createOAuthApp,
  deleteOAuthTokens,
  getDefaultAuthorizationIdForProvider,
  getOAuthApp,
  getOAuthAppById,
  getOAuthTokens,
  isTokenExpiringSoon,
  listAuthorizationSweepRows,
  releaseOAuthRefreshLock,
  storeOAuthTokens,
  updateOAuthAppById,
  updateOAuthTokensAfterRefresh,
  upsertOAuthApp,
} from "../be/db-queries/oauth";

const TEST_DB_PATH = "./test-db-queries-oauth.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("OAuth Apps CRUD", () => {
  test("getOAuthApp returns null for unknown provider", async () => {
    const result = await getOAuthApp("nonexistent");
    expect(result).toBeNull();
  });

  test("upsertOAuthApp creates a new app", async () => {
    await upsertOAuthApp("test-provider", {
      clientId: "client-123",
      clientSecret: "example-secret-456",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      redirectUri: "https://example.com/callback",
      scopes: "read,write",
    });

    const app = await getOAuthApp("test-provider");
    expect(app).not.toBeNull();
    expect(app!.provider).toBe("test-provider");
    expect(app!.clientId).toBe("client-123");
    expect(app!.clientSecret).toBe("example-secret-456");
    expect(app!.authorizeUrl).toBe("https://example.com/authorize");
    expect(app!.tokenUrl).toBe("https://example.com/token");
    expect(app!.redirectUri).toBe("https://example.com/callback");
    expect(app!.scopes).toBe("read,write");
    expect(app!.metadata).toBe("{}");
  });

  test("upsertOAuthApp updates existing app on conflict", async () => {
    await upsertOAuthApp("test-provider", {
      clientId: "client-updated",
      clientSecret: "example-secret-updated",
      authorizeUrl: "https://example.com/authorize-v2",
      tokenUrl: "https://example.com/token-v2",
      redirectUri: "https://example.com/callback-v2",
      scopes: "read,write,admin",
      metadata: '{"key": "value"}',
    });

    const app = await getOAuthApp("test-provider");
    expect(app).not.toBeNull();
    expect(app!.clientId).toBe("client-updated");
    expect(app!.scopes).toBe("read,write,admin");
    expect(app!.metadata).toBe('{"key": "value"}');
  });

  test("multiple providers can coexist", async () => {
    await upsertOAuthApp("provider-a", {
      clientId: "a-client",
      clientSecret: "example-a-secret",
      authorizeUrl: "https://a.com/authorize",
      tokenUrl: "https://a.com/token",
      redirectUri: "https://a.com/callback",
      scopes: "read",
    });
    await upsertOAuthApp("provider-b", {
      clientId: "b-client",
      clientSecret: "example-b-secret",
      authorizeUrl: "https://b.com/authorize",
      tokenUrl: "https://b.com/token",
      redirectUri: "https://b.com/callback",
      scopes: "write",
    });

    const a = await getOAuthApp("provider-a");
    const b = await getOAuthApp("provider-b");
    expect(a!.clientId).toBe("a-client");
    expect(b!.clientId).toBe("b-client");
  });
});

describe("OAuth Apps create vs update-by-id (N apps per provider)", () => {
  const seed = (clientId: string, clientSecret: string) => ({
    clientId,
    clientSecret,
    authorizeUrl: "https://multi.example.com/authorize",
    tokenUrl: "https://multi.example.com/token",
    redirectUri: "https://multi.example.com/callback",
    scopes: "read",
  });

  test("createOAuthApp always inserts a distinct row and never clobbers a sibling", async () => {
    const firstId = await createOAuthApp("multi-create", seed("create-first", "secret-first"));
    const secondId = await createOAuthApp("multi-create", seed("create-second", "secret-second"));

    expect(firstId).not.toBe(secondId);
    const first = await getOAuthAppById(firstId);
    const second = await getOAuthAppById(secondId);
    expect(first!.clientId).toBe("create-first");
    expect(first!.clientSecret).toBe("secret-first");
    expect(second!.clientId).toBe("create-second");
    expect(second!.clientSecret).toBe("secret-second");
  });

  test("updateOAuthAppById updates only the targeted row", async () => {
    const firstId = await createOAuthApp("multi-update", seed("upd-first", "sec-first"));
    const secondId = await createOAuthApp("multi-update", seed("upd-second", "sec-second"));

    await updateOAuthAppById(firstId, seed("upd-first-edited", "sec-first-edited"));

    expect((await getOAuthAppById(firstId))!.clientId).toBe("upd-first-edited");
    expect((await getOAuthAppById(firstId))!.clientSecret).toBe("sec-first-edited");
    // Sibling untouched.
    expect((await getOAuthAppById(secondId))!.clientId).toBe("upd-second");
    expect((await getOAuthAppById(secondId))!.clientSecret).toBe("sec-second");
  });

  test("updateOAuthAppById throws for an unknown id", async () => {
    await expect(updateOAuthAppById("does-not-exist", seed("x", "y"))).rejects.toThrow(/not found/);
  });
});

describe("OAuth Tokens CRUD", () => {
  test("getOAuthTokens returns null for unknown provider", async () => {
    const result = await getOAuthTokens("nonexistent-tokens");
    expect(result).toBeNull();
  });

  test("storeOAuthTokens creates tokens", async () => {
    // Need an oauth_app first (FK constraint)
    await upsertOAuthApp("token-test", {
      clientId: "c",
      clientSecret: "s",
      authorizeUrl: "https://x.com/auth",
      tokenUrl: "https://x.com/token",
      redirectUri: "https://x.com/cb",
      scopes: "read",
    });

    const futureDate = new Date(Date.now() + 3600000).toISOString();
    await storeOAuthTokens("token-test", {
      accessToken: "example-access-abc",
      refreshToken: "example-refresh-xyz",
      expiresAt: futureDate,
      scope: "read,write",
    });

    const tokens = await getOAuthTokens("token-test");
    expect(tokens).not.toBeNull();
    expect(tokens!.provider).toBe("token-test");
    expect(tokens!.accessToken).toBe("example-access-abc");
    expect(tokens!.refreshToken).toBe("example-refresh-xyz");
    expect(tokens!.scope).toBe("read,write");
  });

  test("storeOAuthTokens updates existing tokens (upsert)", async () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();
    await storeOAuthTokens("token-test", {
      accessToken: "example-access-updated",
      expiresAt: futureDate,
    });

    const tokens = await getOAuthTokens("token-test");
    expect(tokens!.accessToken).toBe("example-access-updated");
    // refreshToken should be preserved (COALESCE)
    expect(tokens!.refreshToken).toBe("example-refresh-xyz");
  });

  test("updateOAuthTokensAfterRefresh replaces the rotated refresh token atomically", async () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();
    await storeOAuthTokens("token-test", {
      accessToken: "example-access-before-refresh",
      refreshToken: "example-refresh-before-refresh",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const observed = (await getOAuthTokens("token-test"))!;

    await updateOAuthTokensAfterRefresh("token-test", "example-refresh-before-refresh", {
      accessToken: "example-access-after-refresh",
      refreshToken: "example-refresh-after-refresh",
      expiresAt: futureDate,
      scope: "read,write",
      expectedTokenVersion: observed.tokenVersion,
    });

    const tokens = await getOAuthTokens("token-test");
    expect(tokens!.accessToken).toBe("example-access-after-refresh");
    expect(tokens!.refreshToken).toBe("example-refresh-after-refresh");
    expect(tokens!.expiresAt).toBe(futureDate);
    expect(tokens!.scope).toBe("read,write");
  });

  test("updateOAuthTokensAfterRefresh refuses to overwrite a concurrently rotated token", async () => {
    await storeOAuthTokens("token-test", {
      accessToken: "example-access-current",
      refreshToken: "example-refresh-current",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    await expect(
      updateOAuthTokensAfterRefresh("token-test", "refresh-stale", {
        accessToken: "example-access-stale-result",
        refreshToken: "example-refresh-stale-result",
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
      }),
    ).rejects.toThrow(/stored refresh token changed during refresh/);

    const tokens = await getOAuthTokens("token-test");
    expect(tokens!.accessToken).toBe("example-access-current");
    expect(tokens!.refreshToken).toBe("example-refresh-current");
  });

  test("updateOAuthTokensAfterRefresh rejects a stale version even when the refresh token is unchanged", async () => {
    await storeOAuthTokens("token-test", {
      accessToken: "example-access-observed",
      refreshToken: "example-refresh-stable",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const observed = (await getOAuthTokens("token-test"))!;

    await storeOAuthTokens("token-test", {
      accessToken: "example-access-concurrent-winner",
      refreshToken: "example-refresh-stable",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    await expect(
      updateOAuthTokensAfterRefresh("token-test", "example-refresh-stable", {
        accessToken: "example-access-stale-result",
        refreshToken: "example-refresh-stale-result",
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
        expectedTokenVersion: observed.tokenVersion,
      }),
    ).rejects.toThrow(/no rows updated/);

    const tokens = await getOAuthTokens("token-test");
    expect(tokens?.accessToken).toBe("example-access-concurrent-winner");
    expect(tokens?.refreshToken).toBe("example-refresh-stable");
  });

  test("listAuthorizationSweepRows normalizes legacy bare expiresAt values", async () => {
    await getDbClient().run(
      `UPDATE oauth_authorizations SET expiresAt = '2030-01-02 03:04:05'
       WHERE appId = (SELECT id FROM oauth_apps WHERE provider = 'token-test')
         AND label = 'default'`,
    );

    expect(
      (await listAuthorizationSweepRows()).find((row) => row.provider === "token-test")?.expiresAt,
    ).toBe("2030-01-02T03:04:05.000Z");
  });

  test("deleteOAuthTokens removes tokens", async () => {
    await deleteOAuthTokens("token-test");
    const tokens = await getOAuthTokens("token-test");
    expect(tokens).toBeNull();
  });

  test("deleteOAuthTokens revokes in place and reconnect reuses the authorization id", async () => {
    await upsertOAuthApp("disconnect-continuity", {
      clientId: "client-dc",
      clientSecret: "example-secret-dc",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      redirectUri: "https://example.com/callback",
      scopes: "read",
    });
    await storeOAuthTokens("disconnect-continuity", {
      accessToken: "example-access-original",
      refreshToken: "example-refresh-original",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const originalId = await getDefaultAuthorizationIdForProvider("disconnect-continuity");
    expect(originalId).not.toBeNull();

    await deleteOAuthTokens("disconnect-continuity");
    // Disconnect reads as "no tokens" to provider-string callers ...
    expect(await getOAuthTokens("disconnect-continuity")).toBeNull();
    // ... but the row is KEPT so the binding FK survives.
    expect(await getDefaultAuthorizationIdForProvider("disconnect-continuity")).toBe(originalId);

    await storeOAuthTokens("disconnect-continuity", {
      accessToken: "example-access-reconnected",
      refreshToken: "example-refresh-reconnected",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    // Reconnect reuses the same authorization id.
    expect(await getDefaultAuthorizationIdForProvider("disconnect-continuity")).toBe(originalId);
    const reconnected = await getOAuthTokens("disconnect-continuity");
    expect(reconnected?.id).toBe(originalId);
    expect(reconnected?.accessToken).toBe("example-access-reconnected");
  });
});

describe("isTokenExpiringSoon", () => {
  test("returns true when no tokens exist", async () => {
    expect(await isTokenExpiringSoon("nonexistent")).toBe(true);
  });

  test("returns false for tokens expiring far in the future", async () => {
    await upsertOAuthApp("expiry-test", {
      clientId: "c",
      clientSecret: "s",
      authorizeUrl: "https://x.com/auth",
      tokenUrl: "https://x.com/token",
      redirectUri: "https://x.com/cb",
      scopes: "read",
    });

    const farFuture = new Date(Date.now() + 24 * 3600000).toISOString();
    await storeOAuthTokens("expiry-test", {
      accessToken: "a",
      expiresAt: farFuture,
    });

    expect(await isTokenExpiringSoon("expiry-test")).toBe(false);
  });

  test("returns true for tokens expiring within buffer", async () => {
    const almostExpired = new Date(Date.now() + 60000).toISOString(); // 1 minute from now
    await storeOAuthTokens("expiry-test", {
      accessToken: "a",
      expiresAt: almostExpired,
    });

    // Default buffer is 5 minutes, token expires in 1 minute → expiring soon
    expect(await isTokenExpiringSoon("expiry-test")).toBe(true);
  });

  test("respects custom buffer", async () => {
    const twoMinutes = new Date(Date.now() + 120000).toISOString();
    await storeOAuthTokens("expiry-test", {
      accessToken: "a",
      expiresAt: twoMinutes,
    });

    // With 1-minute buffer, 2-minute token is fine
    expect(await isTokenExpiringSoon("expiry-test", 60000)).toBe(false);
    // With 3-minute buffer, 2-minute token is expiring soon
    expect(await isTokenExpiringSoon("expiry-test", 180000)).toBe(true);
  });
});

describe("OAuth refresh locks", () => {
  test("allows only one owner until the lock is released", async () => {
    const owner = await acquireOAuthRefreshLock("lock-test", 60_000);
    expect(typeof owner).toBe("string");

    expect(await acquireOAuthRefreshLock("lock-test", 60_000)).toBeNull();

    await releaseOAuthRefreshLock("lock-test", owner!);
    const nextOwner = await acquireOAuthRefreshLock("lock-test", 60_000);
    expect(typeof nextOwner).toBe("string");
    await releaseOAuthRefreshLock("lock-test", nextOwner!);
  });

  test("allows a new owner after the lock expires", async () => {
    const expiredOwner = await acquireOAuthRefreshLock("expired-lock-test", -1_000);
    expect(typeof expiredOwner).toBe("string");

    const nextOwner = await acquireOAuthRefreshLock("expired-lock-test", 60_000);
    expect(typeof nextOwner).toBe("string");
    expect(nextOwner).not.toBe(expiredOwner);

    await releaseOAuthRefreshLock("expired-lock-test", nextOwner!);
  });
});
