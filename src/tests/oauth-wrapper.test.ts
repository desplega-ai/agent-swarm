import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { consumeOAuthPending, upsertOAuthApp } from "../be/db-queries/oauth";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  type OAuthProviderConfig,
} from "../oauth/wrapper";

const TEST_DB_PATH = "./test-oauth-wrapper.sqlite";

const testConfig: OAuthProviderConfig = {
  provider: "test-provider",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  redirectUri: "http://localhost:3013/api/oauth/callback",
  scopes: ["read", "write"],
  extraParams: { actor: "app" },
};

beforeAll(() => {
  initDb(TEST_DB_PATH);
  // Create an oauth_app row so pending persistence works (FK constraint on appId).
  upsertOAuthApp("test-provider", {
    clientId: testConfig.clientId,
    clientSecret: testConfig.clientSecret,
    authorizeUrl: testConfig.authorizeUrl,
    tokenUrl: testConfig.tokenUrl,
    redirectUri: testConfig.redirectUri,
    scopes: testConfig.scopes.join(","),
  });
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
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3013/api/oauth/callback");
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

  test("persists a DB pending row (default label, generic flow) with the code verifier", async () => {
    const result = await buildAuthorizationUrl(testConfig);
    const pending = consumeOAuthPending(result.state);

    expect(pending).toBeTruthy();
    expect(pending!.codeVerifier).toBe(result.codeVerifier);
    expect(pending!.label).toBe("default");
    expect(pending!.flow).toBe("generic");
    expect(pending!.redirectUri).toBe(testConfig.redirectUri);
  });

  test("honors an explicit label option", async () => {
    const result = await buildAuthorizationUrl(testConfig, { label: "support" });
    const pending = consumeOAuthPending(result.state);
    expect(pending!.label).toBe("support");
  });

  test("generates unique state for each call", async () => {
    const result1 = await buildAuthorizationUrl(testConfig);
    const result2 = await buildAuthorizationUrl(testConfig);

    expect(result1.state).not.toBe(result2.state);
    expect(result1.codeVerifier).not.toBe(result2.codeVerifier);
  });

  test("throws when the provider has no configured app", async () => {
    await expect(
      buildAuthorizationUrl({ ...testConfig, provider: "no-such-provider" }),
    ).rejects.toThrow("is not configured");
  });

  test("works without extra params", async () => {
    const configNoExtras: OAuthProviderConfig = { ...testConfig, extraParams: undefined };
    const result = await buildAuthorizationUrl(configNoExtras);
    const url = new URL(result.url);
    expect(url.searchParams.get("actor")).toBeNull();
  });
});

describe("exchangeAuthorizationCode", () => {
  test("exchanges a code for tokens (pure — no persistence)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        access_token: "atk",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rtk",
        scope: "read write",
      }),
    );
    try {
      const tokens = await exchangeAuthorizationCode(testConfig, {
        code: "the-code",
        codeVerifier: "the-verifier",
        redirectUri: testConfig.redirectUri,
      });
      expect(tokens.accessToken).toBe("atk");
      expect(tokens.refreshToken).toBe("rtk");
      expect(tokens.expiresIn).toBe(3600);
      expect(tokens.scope).toBe("read write");
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(init.body)).toContain("grant_type=authorization_code");
      expect(String(init.body)).toContain("code=the-code");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("throws on a non-OK token response", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("nope", { status: 400 }),
    );
    try {
      await expect(
        exchangeAuthorizationCode(testConfig, {
          code: "x",
          codeVerifier: "y",
          redirectUri: testConfig.redirectUri,
        }),
      ).rejects.toThrow("Token exchange failed");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("sends Accept: application/json so form-encoding providers (GitHub) return JSON", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ access_token: "atk", token_type: "Bearer" }),
    );
    try {
      await exchangeAuthorizationCode(testConfig, {
        code: "the-code",
        codeVerifier: "the-verifier",
        redirectUri: testConfig.redirectUri,
      });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
