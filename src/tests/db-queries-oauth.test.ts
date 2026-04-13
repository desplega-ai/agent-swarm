import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  deleteOAuthTokens,
  getOAuthApp,
  getOAuthTokens,
  isTokenExpiringSoon,
  storeOAuthTokens,
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
  test("getOAuthApp returns null for unknown provider", () => {
    const result = getOAuthApp("nonexistent");
    expect(result).toBeNull();
  });

  test("upsertOAuthApp creates a new app", () => {
    upsertOAuthApp("test-provider", {
      clientId: "client-123",
      clientSecret: "secret-456",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      redirectUri: "https://example.com/callback",
      scopes: "read,write",
    });

    const app = getOAuthApp("test-provider");
    expect(app).not.toBeNull();
    expect(app!.provider).toBe("test-provider");
    expect(app!.clientId).toBe("client-123");
    expect(app!.clientSecret).toBe("secret-456");
    expect(app!.authorizeUrl).toBe("https://example.com/authorize");
    expect(app!.tokenUrl).toBe("https://example.com/token");
    expect(app!.redirectUri).toBe("https://example.com/callback");
    expect(app!.scopes).toBe("read,write");
    expect(app!.metadata).toBe("{}");
  });

  test("upsertOAuthApp updates existing app on conflict", () => {
    upsertOAuthApp("test-provider", {
      clientId: "client-updated",
      clientSecret: "secret-updated",
      authorizeUrl: "https://example.com/authorize-v2",
      tokenUrl: "https://example.com/token-v2",
      redirectUri: "https://example.com/callback-v2",
      scopes: "read,write,admin",
      metadata: '{"key": "value"}',
    });

    const app = getOAuthApp("test-provider");
    expect(app).not.toBeNull();
    expect(app!.clientId).toBe("client-updated");
    expect(app!.scopes).toBe("read,write,admin");
    expect(app!.metadata).toBe('{"key": "value"}');
  });

  test("multiple providers can coexist", () => {
    upsertOAuthApp("provider-a", {
      clientId: "a-client",
      clientSecret: "a-secret",
      authorizeUrl: "https://a.com/authorize",
      tokenUrl: "https://a.com/token",
      redirectUri: "https://a.com/callback",
      scopes: "read",
    });
    upsertOAuthApp("provider-b", {
      clientId: "b-client",
      clientSecret: "b-secret",
      authorizeUrl: "https://b.com/authorize",
      tokenUrl: "https://b.com/token",
      redirectUri: "https://b.com/callback",
      scopes: "write",
    });

    const a = getOAuthApp("provider-a");
    const b = getOAuthApp("provider-b");
    expect(a!.clientId).toBe("a-client");
    expect(b!.clientId).toBe("b-client");
  });
});

describe("OAuth Tokens CRUD", () => {
  test("getOAuthTokens returns null for unknown provider", () => {
    const result = getOAuthTokens("nonexistent-tokens");
    expect(result).toBeNull();
  });

  test("storeOAuthTokens creates tokens", () => {
    // Need an oauth_app first (FK constraint)
    upsertOAuthApp("token-test", {
      clientId: "c",
      clientSecret: "s",
      authorizeUrl: "https://x.com/auth",
      tokenUrl: "https://x.com/token",
      redirectUri: "https://x.com/cb",
      scopes: "read",
    });

    const futureDate = new Date(Date.now() + 3600000).toISOString();
    storeOAuthTokens("token-test", {
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAt: futureDate,
      scope: "read,write",
    });

    const tokens = getOAuthTokens("token-test");
    expect(tokens).not.toBeNull();
    expect(tokens!.provider).toBe("token-test");
    expect(tokens!.accessToken).toBe("access-abc");
    expect(tokens!.refreshToken).toBe("refresh-xyz");
    expect(tokens!.scope).toBe("read,write");
  });

  test("storeOAuthTokens updates existing tokens (upsert)", () => {
    const futureDate = new Date(Date.now() + 7200000).toISOString();
    storeOAuthTokens("token-test", {
      accessToken: "access-updated",
      expiresAt: futureDate,
    });

    const tokens = getOAuthTokens("token-test");
    expect(tokens!.accessToken).toBe("access-updated");
    // refreshToken should be preserved (COALESCE)
    expect(tokens!.refreshToken).toBe("refresh-xyz");
  });

  test("deleteOAuthTokens removes tokens", () => {
    deleteOAuthTokens("token-test");
    const tokens = getOAuthTokens("token-test");
    expect(tokens).toBeNull();
  });
});

describe("isTokenExpiringSoon", () => {
  test("returns true when no tokens exist", () => {
    expect(isTokenExpiringSoon("nonexistent")).toBe(true);
  });

  test("returns false for tokens expiring far in the future", () => {
    upsertOAuthApp("expiry-test", {
      clientId: "c",
      clientSecret: "s",
      authorizeUrl: "https://x.com/auth",
      tokenUrl: "https://x.com/token",
      redirectUri: "https://x.com/cb",
      scopes: "read",
    });

    const farFuture = new Date(Date.now() + 24 * 3600000).toISOString();
    storeOAuthTokens("expiry-test", {
      accessToken: "a",
      expiresAt: farFuture,
    });

    expect(isTokenExpiringSoon("expiry-test")).toBe(false);
  });

  test("returns true for tokens expiring within buffer", () => {
    const almostExpired = new Date(Date.now() + 60000).toISOString(); // 1 minute from now
    storeOAuthTokens("expiry-test", {
      accessToken: "a",
      expiresAt: almostExpired,
    });

    // Default buffer is 5 minutes, token expires in 1 minute → expiring soon
    expect(isTokenExpiringSoon("expiry-test")).toBe(true);
  });

  test("respects custom buffer", () => {
    const twoMinutes = new Date(Date.now() + 120000).toISOString();
    storeOAuthTokens("expiry-test", {
      accessToken: "a",
      expiresAt: twoMinutes,
    });

    // With 1-minute buffer, 2-minute token is fine
    expect(isTokenExpiringSoon("expiry-test", 60000)).toBe(false);
    // With 3-minute buffer, 2-minute token is expiring soon
    expect(isTokenExpiringSoon("expiry-test", 180000)).toBe(true);
  });
});
