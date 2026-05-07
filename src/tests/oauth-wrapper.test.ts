import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import {
  _clearPendingStates,
  _getPendingState,
  buildAuthorizationUrl,
  exchangeCode,
  type OAuthProviderConfig,
} from "../oauth/wrapper";

const TEST_DB_PATH = "./test-oauth-wrapper.sqlite";

const testConfig: OAuthProviderConfig = {
  provider: "test-provider",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  redirectUri: "http://localhost:3013/callback",
  scopes: ["read", "write"],
  extraParams: { actor: "app" },
};

beforeAll(() => {
  initDb(TEST_DB_PATH);
  // Create an oauth_app row so token storage works (FK constraint)
  upsertOAuthApp("test-provider", {
    clientId: testConfig.clientId,
    clientSecret: testConfig.clientSecret,
    authorizeUrl: testConfig.authorizeUrl,
    tokenUrl: testConfig.tokenUrl,
    redirectUri: testConfig.redirectUri,
    scopes: testConfig.scopes.join(","),
  });
});

beforeEach(() => {
  _clearPendingStates();
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("buildAuthorizationUrl", () => {
  test("generates a valid URL with PKCE params", async () => {
    const result = await buildAuthorizationUrl(testConfig);

    expect(result.url).toBeTruthy();
    expect(result.state).toBeTruthy();
    expect(result.codeVerifier).toBeTruthy();

    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe("https://example.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3013/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read,write");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("includes extra params in the URL", async () => {
    const result = await buildAuthorizationUrl(testConfig);
    const url = new URL(result.url);
    expect(url.searchParams.get("actor")).toBe("app");
  });

  test("stores pending state with code verifier", async () => {
    const result = await buildAuthorizationUrl(testConfig);
    const pending = _getPendingState(result.state);

    expect(pending).toBeTruthy();
    expect(pending!.codeVerifier).toBe(result.codeVerifier);
    expect(pending!.config.provider).toBe("test-provider");
    expect(pending!.createdAt).toBeGreaterThan(0);
  });

  test("generates unique state for each call", async () => {
    const result1 = await buildAuthorizationUrl(testConfig);
    const result2 = await buildAuthorizationUrl(testConfig);

    expect(result1.state).not.toBe(result2.state);
    expect(result1.codeVerifier).not.toBe(result2.codeVerifier);
  });

  test("works without extra params", async () => {
    const configNoExtras: OAuthProviderConfig = {
      ...testConfig,
      extraParams: undefined,
    };

    const result = await buildAuthorizationUrl(configNoExtras);
    const url = new URL(result.url);
    expect(url.searchParams.get("actor")).toBeNull();
  });
});

describe("exchangeCode", () => {
  test("rejects invalid state", async () => {
    await expect(exchangeCode(testConfig, "some-code", "invalid-state")).rejects.toThrow(
      "Invalid or expired OAuth state",
    );
  });

  test("rejects already-consumed state", async () => {
    const result = await buildAuthorizationUrl(testConfig);

    // Mock fetch to fail immediately (avoids real network call to example.com)
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
    try {
      await exchangeCode(testConfig, "some-code", result.state);
    } catch {
      // Expected: fetch fails, but state is consumed
    } finally {
      fetchSpy.mockRestore();
    }

    // Second attempt with the same state should fail with "Invalid or expired"
    await expect(exchangeCode(testConfig, "some-code", result.state)).rejects.toThrow(
      "Invalid or expired OAuth state",
    );
  });
});

describe("Notion-shape options (additive — defaults preserve Linear/Jira)", () => {
  const notionConfig: OAuthProviderConfig = {
    provider: "notion-test",
    clientId: "notion-client",
    clientSecret: "notion-secret",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    redirectUri: "http://localhost:3013/cb",
    scopes: [],
    extraParams: { owner: "user" },
    tokenAuthMode: "basic",
    tokenContentType: "json",
    extraTokenHeaders: { "Notion-Version": "2026-03-11" },
    usePkce: false,
    defaultTokenLifetimeMs: 60 * 60 * 1000,
  };

  beforeAll(() => {
    upsertOAuthApp("notion-test", {
      clientId: notionConfig.clientId,
      clientSecret: notionConfig.clientSecret,
      authorizeUrl: notionConfig.authorizeUrl,
      tokenUrl: notionConfig.tokenUrl,
      redirectUri: notionConfig.redirectUri,
      scopes: "",
    });
  });

  test("usePkce: false omits code_challenge from authorize URL", async () => {
    const result = await buildAuthorizationUrl(notionConfig);
    const url = new URL(result.url);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
  });

  test("empty scopes array omits scope param entirely", async () => {
    const result = await buildAuthorizationUrl(notionConfig);
    const url = new URL(result.url);
    expect(url.searchParams.has("scope")).toBe(false);
  });

  test("extraParams (owner=user) are appended to authorize URL", async () => {
    const result = await buildAuthorizationUrl(notionConfig);
    const url = new URL(result.url);
    expect(url.searchParams.get("owner")).toBe("user");
  });

  test("tokenAuthMode=basic + tokenContentType=json + extraTokenHeaders shape token request", async () => {
    const buildResult = await buildAuthorizationUrl(notionConfig);

    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing for spy
      async (url: any, init?: any) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            access_token: "at_1",
            token_type: "bearer",
            refresh_token: "rt_1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    try {
      await exchangeCode(notionConfig, "auth-code", buildResult.state);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(capturedUrl).toBe(notionConfig.tokenUrl);
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.Authorization.split(" ")[1] ?? "", "base64").toString();
    expect(decoded).toBe(`${notionConfig.clientId}:${notionConfig.clientSecret}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Notion-Version"]).toBe("2026-03-11");

    const body = JSON.parse(capturedInit!.body as string) as Record<string, unknown>;
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("auth-code");
    expect(body.redirect_uri).toBe(notionConfig.redirectUri);
    // No client creds in body when basic auth is used
    expect(body.client_id).toBeUndefined();
    expect(body.client_secret).toBeUndefined();
    // No PKCE verifier when usePkce=false
    expect(body.code_verifier).toBeUndefined();
  });

  test("defaultTokenLifetimeMs governs expiresAt when expires_in is missing", async () => {
    const buildResult = await buildAuthorizationUrl(notionConfig);

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_2", token_type: "bearer", refresh_token: "rt_2" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    try {
      const before = Date.now();
      await exchangeCode(notionConfig, "code-x", buildResult.state);
      const after = Date.now();

      const tokens = (await import("../be/db-queries/oauth")).getOAuthTokens("notion-test");
      expect(tokens).toBeTruthy();
      const expiresAtMs = new Date(tokens!.expiresAt).getTime();
      // Should fall in [before + 1h, after + 1h] (defaultTokenLifetimeMs)
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 1000);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("refreshAccessToken honors basic auth + json + extraTokenHeaders", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: fetch typing for spy
      async (_url: any, init?: any) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({ access_token: "at_3", token_type: "bearer", refresh_token: "rt_3" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    try {
      const { refreshAccessToken } = await import("../oauth/wrapper");
      await refreshAccessToken(notionConfig, "old-rt");
    } finally {
      fetchSpy.mockRestore();
    }

    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Notion-Version"]).toBe("2026-03-11");

    const body = JSON.parse(capturedInit!.body as string) as Record<string, unknown>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("old-rt");
    expect(body.client_id).toBeUndefined();
    expect(body.client_secret).toBeUndefined();
  });
});

describe("state TTL cleanup", () => {
  test("expired states are cleaned up on next buildAuthorizationUrl call", async () => {
    // Manually insert an "expired" entry by backdating createdAt
    const result = await buildAuthorizationUrl(testConfig);
    const pending = _getPendingState(result.state);
    expect(pending).toBeTruthy();

    // Backdate to 11 minutes ago (past the 10-minute TTL)
    pending!.createdAt = Date.now() - 11 * 60 * 1000;

    // Building a new URL triggers cleanup
    await buildAuthorizationUrl(testConfig);

    // The expired state should be gone
    const expired = _getPendingState(result.state);
    expect(expired).toBeUndefined();
  });
});
