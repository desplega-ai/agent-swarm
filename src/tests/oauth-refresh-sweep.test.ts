import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import {
  getAuthorizationById,
  getDefaultAuthorizationIdForProvider,
  getOAuthTokens,
  storeOAuthTokens,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { sweepOAuthTokenRefresh } from "../be/oauth-refresh-sweep";

function authorizationStatus(provider: string): string | undefined {
  const id = getDefaultAuthorizationIdForProvider(provider);
  return id ? getAuthorizationById(id)?.status : undefined;
}

const TEST_DB_PATH = "./test-oauth-refresh-sweep.sqlite";

const originalFetch = globalThis.fetch;

function appConfig(provider: string) {
  return {
    clientId: `${provider}-client-id`,
    clientSecret: `${provider}-client-secret`,
    authorizeUrl: `https://oauth.${provider}.test/authorize`,
    tokenUrl: `https://oauth.${provider}.test/token`,
    redirectUri: "http://localhost:3013/callback",
    scopes: "read,write",
  };
}

function seedTokens(
  provider: string,
  opts: { expiresInMs: number; refreshToken?: string | null } = { expiresInMs: 3_600_000 },
): void {
  storeOAuthTokens(provider, {
    accessToken: `${provider}-old-access-token`,
    refreshToken: opts.refreshToken === undefined ? `${provider}-refresh-token` : opts.refreshToken,
    expiresAt: new Date(Date.now() + opts.expiresInMs).toISOString(),
    scope: "read,write",
  });
}

function backdateTokenRow(provider: string, ageMs: number): void {
  const backdated = new Date(Date.now() - ageMs).toISOString();
  getDb()
    .query(
      `UPDATE oauth_authorizations SET updatedAt = ?
       WHERE appId = (SELECT id FROM oauth_apps WHERE provider = ? AND mcpServerId IS NULL LIMIT 1)
         AND label = 'default'`,
    )
    .run(backdated, provider);
}

type CapturedTokenRequest = { url: string; body: string };

/**
 * Mock the global fetch as a token endpoint. Responds 200 with a fresh token
 * for every URL except those listed in `failUrls` (which get a 500).
 */
function mockTokenEndpoint(failUrls: string[] = []): CapturedTokenRequest[] {
  const captured: CapturedTokenRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (failUrls.includes(url)) {
      return new Response("upstream broke", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        access_token: "new-access-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "new-refresh-token",
        scope: "read,write",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return captured;
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  getDb().run("DELETE FROM oauth_refresh_locks");
  getDb().run("DELETE FROM oauth_authorizations");
  getDb().run("DELETE FROM oauth_apps");
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
});

describe("sweepOAuthTokenRefresh", () => {
  test("refreshes a row whose access token expires within 30 minutes", async () => {
    upsertOAuthApp("vendor_a", appConfig("vendor_a"));
    seedTokens("vendor_a", { expiresInMs: 10 * 60 * 1000 }); // expires in 10 min

    const captured = mockTokenEndpoint();
    const result = await sweepOAuthTokenRefresh();

    expect(result).toEqual({ checked: 1, refreshed: 1, skipped: 0, failed: [] });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://oauth.vendor_a.test/token");
    expect(captured[0]?.body).toContain("grant_type=refresh_token");
    expect(getOAuthTokens("vendor_a")?.accessToken).toBe("new-access-token");
  });

  test("skips rows with no refresh token", async () => {
    upsertOAuthApp("vendor_a", appConfig("vendor_a"));
    seedTokens("vendor_a", { expiresInMs: 10 * 60 * 1000, refreshToken: null });

    const captured = mockTokenEndpoint();
    const result = await sweepOAuthTokenRefresh();

    expect(result).toEqual({ checked: 1, refreshed: 0, skipped: 1, failed: [] });
    expect(captured).toHaveLength(0);
    expect(getOAuthTokens("vendor_a")?.accessToken).toBe("vendor_a-old-access-token");
  });

  test("skips fresh rows that are neither expiring nor stale", async () => {
    upsertOAuthApp("vendor_a", appConfig("vendor_a"));
    seedTokens("vendor_a", { expiresInMs: 24 * 60 * 60 * 1000 }); // expires in 24h, just updated

    const captured = mockTokenEndpoint();
    const result = await sweepOAuthTokenRefresh();

    expect(result).toEqual({ checked: 1, refreshed: 0, skipped: 1, failed: [] });
    expect(captured).toHaveLength(0);
  });

  test("keep-alives a stale row even when the access token is far from expiry", async () => {
    upsertOAuthApp("vendor_a", appConfig("vendor_a"));
    seedTokens("vendor_a", { expiresInMs: 30 * 24 * 60 * 60 * 1000 }); // expires in 30 days
    backdateTokenRow("vendor_a", 8 * 24 * 60 * 60 * 1000); // untouched for 8 days

    const captured = mockTokenEndpoint();
    const result = await sweepOAuthTokenRefresh();

    expect(result).toEqual({ checked: 1, refreshed: 1, skipped: 0, failed: [] });
    expect(captured).toHaveLength(1);
    expect(getOAuthTokens("vendor_a")?.accessToken).toBe("new-access-token");
  });

  test("survives a failing provider and still refreshes the others", async () => {
    // "a_broken" sorts before "b_healthy", proving the sweep continues past a failure.
    upsertOAuthApp("a_broken", appConfig("a_broken"));
    upsertOAuthApp("b_healthy", appConfig("b_healthy"));
    seedTokens("a_broken", { expiresInMs: 10 * 60 * 1000 });
    seedTokens("b_healthy", { expiresInMs: 10 * 60 * 1000 });

    const captured = mockTokenEndpoint(["https://oauth.a_broken.test/token"]);
    const result = await sweepOAuthTokenRefresh();

    expect(result.checked).toBe(2);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain("a_broken");
    expect(captured.map((request) => request.url).sort()).toEqual([
      "https://oauth.a_broken.test/token",
      "https://oauth.b_healthy.test/token",
    ]);
    expect(getOAuthTokens("a_broken")?.accessToken).toBe("a_broken-old-access-token");
    expect(getOAuthTokens("b_healthy")?.accessToken).toBe("new-access-token");
    // A failing refresh persists refresh-failed on the authorization; the
    // healthy one stays active.
    expect(authorizationStatus("a_broken")).toBe("refresh-failed");
    expect(authorizationStatus("b_healthy")).toBe("active");
  });

  test("a refresh-failed authorization stays in the sweep and heals on the next pass", async () => {
    upsertOAuthApp("vendor_a", appConfig("vendor_a"));
    // Not expiring on its own — the only reason it should be swept is the
    // persisted refresh-failed status.
    seedTokens("vendor_a", { expiresInMs: 24 * 60 * 60 * 1000 });

    // Pass 1: provider is down → status flips to refresh-failed.
    mockTokenEndpoint(["https://oauth.vendor_a.test/token"]);
    // Force a first failure via a near-expiry token so the sweep attempts it.
    getDb()
      .query(
        `UPDATE oauth_authorizations SET expiresAt = ?
         WHERE appId = (SELECT id FROM oauth_apps WHERE provider = 'vendor_a' AND mcpServerId IS NULL LIMIT 1)
           AND label = 'default'`,
      )
      .run(new Date(Date.now() + 60 * 1000).toISOString());
    const first = await sweepOAuthTokenRefresh();
    expect(first.failed).toHaveLength(1);
    expect(authorizationStatus("vendor_a")).toBe("refresh-failed");

    // Bump expiry far into the future so the ONLY reason to sweep is the
    // refresh-failed status, proving failed rows are retried each pass.
    getDb()
      .query(
        `UPDATE oauth_authorizations SET expiresAt = ?
         WHERE appId = (SELECT id FROM oauth_apps WHERE provider = 'vendor_a' AND mcpServerId IS NULL LIMIT 1)
           AND label = 'default'`,
      )
      .run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());

    // Pass 2: provider recovers → refresh succeeds → status back to active.
    mockTokenEndpoint();
    const second = await sweepOAuthTokenRefresh();
    expect(second.refreshed).toBe(1);
    expect(second.failed).toHaveLength(0);
    expect(authorizationStatus("vendor_a")).toBe("active");
    expect(getOAuthTokens("vendor_a")?.accessToken).toBe("new-access-token");
  });
});
