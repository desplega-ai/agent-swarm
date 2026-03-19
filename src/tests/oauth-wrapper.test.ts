import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

    // First exchange attempt will fail because there's no real token server,
    // but it should consume the state
    try {
      await exchangeCode(testConfig, "some-code", result.state);
    } catch {
      // Expected: fetch to token URL fails
    }

    // Second attempt with the same state should fail with "Invalid or expired"
    await expect(exchangeCode(testConfig, "some-code", result.state)).rejects.toThrow(
      "Invalid or expired OAuth state",
    );
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
