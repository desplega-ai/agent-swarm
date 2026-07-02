import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  deleteOAuthTokens,
  getOAuthTokens,
  storeOAuthTokens,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { resolveOAuthAccessToken } from "../tools/oauth-access-token";
import {
  clearVolatileSecretsForTesting,
  refreshSecretScrubberCache,
  scrubSecrets,
} from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-oauth-access-token-tool.sqlite";
const originalFetch = globalThis.fetch;

const testApp = {
  clientId: "client-id",
  clientSecret: "client-secret",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  redirectUri: "http://localhost:3013/callback",
  scopes: "read,write",
};

beforeAll(() => {
  initDb(TEST_DB_PATH);
  upsertOAuthApp("linear", testApp);
  upsertOAuthApp("jira", {
    ...testApp,
    tokenUrl: "https://example.com/jira/oauth/token",
  });
  upsertOAuthApp("custom-provider", {
    ...testApp,
    tokenUrl: "https://example.com/custom/oauth/token",
  });
});

beforeEach(() => {
  deleteOAuthTokens("linear");
  deleteOAuthTokens("jira");
  deleteOAuthTokens("custom-provider");
  globalThis.fetch = originalFetch;
  clearVolatileSecretsForTesting();
  refreshSecretScrubberCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearVolatileSecretsForTesting();
  refreshSecretScrubberCache();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("resolveOAuthAccessToken", () => {
  test("returns a fresh access token and registers it for scrubber redaction", async () => {
    const accessToken = "linear-access-token-plain-value-1234567890";
    storeOAuthTokens("linear", {
      accessToken,
      refreshToken: "linear-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await resolveOAuthAccessToken("linear");

    expect(result).toEqual({
      provider: "linear",
      accessToken,
      expiresAt: result.expiresAt,
      tokenType: "Bearer",
    });
    expect(scrubSecrets(`Authorization: Bearer ${accessToken}`)).toBe(
      "Authorization: Bearer [REDACTED:LINEAR_OAUTH_ACCESS_TOKEN]",
    );
  });

  test("supports any configured OAuth provider slug", async () => {
    storeOAuthTokens("custom-provider", {
      accessToken: "custom-provider-access-token-plain-value",
      refreshToken: "custom-provider-refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await resolveOAuthAccessToken("custom-provider");

    expect(result.provider).toBe("custom-provider");
    expect(result.accessToken).toBe("custom-provider-access-token-plain-value");
  });

  test("refreshes Jira before returning a near-expiry token", async () => {
    storeOAuthTokens("jira", {
      accessToken: "old-jira-access-token",
      refreshToken: "old-jira-refresh-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const fetchSpy = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-jira-access-token-plain-value",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "new-jira-refresh-token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = fetchSpy;

    const result = await resolveOAuthAccessToken("jira");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("new-jira-access-token-plain-value");
    expect(getOAuthTokens("jira")?.refreshToken).toBe("new-jira-refresh-token");
  });

  test("rejects a near-expiry token when no refresh token is available", async () => {
    storeOAuthTokens("jira", {
      accessToken: "stale-jira-access-token",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(resolveOAuthAccessToken("jira")).rejects.toThrow(/could not be refreshed/);
  });
});
