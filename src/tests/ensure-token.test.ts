import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  deleteOAuthTokens,
  getOAuthTokens,
  storeOAuthTokens,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { ensureToken } from "../oauth/ensure-token";

const TEST_DB_PATH = "./test-ensure-token.sqlite";

const testApp = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  redirectUri: "http://localhost:3013/callback",
  scopes: "read,write",
};

const originalFetch = globalThis.fetch;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("test-provider", testApp);
});

beforeEach(() => {
  deleteOAuthTokens("test-provider");
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("ensureToken", () => {
  test("does nothing when token is not expiring", async () => {
    storeOAuthTokens("test-provider", {
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
    });

    const fetchSpy = mock(() => Promise.resolve(new Response()));
    globalThis.fetch = fetchSpy;

    await ensureToken("test-provider");

    // No fetch call should have been made — token is still valid
    expect(fetchSpy).not.toHaveBeenCalled();

    // Token should be unchanged
    const tokens = getOAuthTokens("test-provider");
    expect(tokens?.accessToken).toBe("valid-token");
  });

  test("refreshes token when expiring soon", async () => {
    storeOAuthTokens("test-provider", {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 minutes (within 5-min buffer)
    });

    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "new-refresh-token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = fetchSpy;

    await ensureToken("test-provider");

    // Should have called the token endpoint
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=refresh-token");

    // Token should be updated in DB
    const tokens = getOAuthTokens("test-provider");
    expect(tokens?.accessToken).toBe("new-access-token");
    expect(tokens?.refreshToken).toBe("new-refresh-token");
  });

  test("handles gracefully when no tokens exist", async () => {
    // No tokens stored — isTokenExpiringSoon returns true but no refresh token available
    deleteOAuthTokens("test-provider");

    const fetchSpy = mock(() => Promise.resolve(new Response()));
    globalThis.fetch = fetchSpy;

    // Should not throw
    await ensureToken("test-provider");

    // No fetch call — can't refresh without a refresh token
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("handles gracefully when no OAuth app is configured", async () => {
    // Store expiring token for the configured provider, but query a nonexistent one
    const fetchSpy = mock(() => Promise.resolve(new Response()));
    globalThis.fetch = fetchSpy;

    // Should not throw for unconfigured provider
    await ensureToken("nonexistent-provider");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("handles refresh failure gracefully", async () => {
    storeOAuthTokens("test-provider", {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // 1 minute from now
    });

    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchSpy;

    // Should not throw — error is caught and logged
    await ensureToken("test-provider");

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Original token should still be in DB (refresh failed)
    const tokens = getOAuthTokens("test-provider");
    expect(tokens?.accessToken).toBe("old-token");
  });

  test("refreshes token when custom bufferMs makes it 'expiring soon'", async () => {
    storeOAuthTokens("test-provider", {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), // 12h from now
    });

    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "refreshed-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "new-refresh-token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = fetchSpy;

    // With default 5-min buffer, 12h remaining would NOT trigger refresh
    await ensureToken("test-provider");
    expect(fetchSpy).not.toHaveBeenCalled();

    // With 13h buffer, 12h remaining IS within the buffer → triggers refresh
    await ensureToken("test-provider", 13 * 60 * 60 * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const tokens = getOAuthTokens("test-provider");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  test("handles token with no refresh token", async () => {
    storeOAuthTokens("test-provider", {
      accessToken: "old-token",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // 1 minute from now
    });

    const fetchSpy = mock(() => Promise.resolve(new Response()));
    globalThis.fetch = fetchSpy;

    // Should not throw
    await ensureToken("test-provider");

    // No fetch — can't refresh without a refresh token
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
