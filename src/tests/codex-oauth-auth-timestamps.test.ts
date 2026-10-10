import { describe, expect, test } from "bun:test";
import { codexOAuthAuthJson } from "../../scripts/e2e/harness";
import { authJsonToCredentials, credentialsToAuthJson } from "../providers/codex-oauth/auth-json";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types";

const credentials: CodexOAuthCredentials = {
  access: "example-access-token",
  refresh: "example-refresh-token",
  accountId: "example-account",
  expires: Date.UTC(2099, 0, 1),
};

describe("Codex auth.json timestamps", () => {
  test("records the write time separately from the access-token expiry", () => {
    const before = Date.now();
    const auth = credentialsToAuthJson(credentials);
    const after = Date.now();

    expect(Date.parse(auth.last_refresh)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(auth.last_refresh)).toBeLessThanOrEqual(after);
    expect(authJsonToCredentials(auth).expires).toBe(credentials.expires);
  });

  test("reads expiry from a native CLI JWT instead of last_refresh", () => {
    const expiresSeconds = 1_800_000_000;
    const access = `header.${btoa(JSON.stringify({ exp: expiresSeconds }))}.signature`;
    const auth = {
      auth_mode: "chatgpt" as const,
      OPENAI_API_KEY: null,
      tokens: {
        id_token: access,
        access_token: access,
        refresh_token: credentials.refresh,
        account_id: credentials.accountId,
      },
      last_refresh: "2026-10-01T00:00:00.000Z",
    };

    expect(authJsonToCredentials(auth).expires).toBe(expiresSeconds * 1000);
  });

  test("prefers the current JWT over metadata left from an older token", () => {
    const auth = credentialsToAuthJson(credentials);
    auth.tokens.access_token = `header.${btoa(JSON.stringify({ exp: 1_800_000_000 }))}.signature`;
    expect(authJsonToCredentials(auth).expires).toBe(1_800_000_000_000);
  });

  test("retains the explicit expiry when a JWT has no usable exp claim", () => {
    for (const exp of [undefined, "1800000000", null, -1]) {
      const access = `header.${btoa(JSON.stringify({ exp }))}.signature`;
      const auth = credentialsToAuthJson({ ...credentials, access });
      expect(authJsonToCredentials(auth).expires).toBe(credentials.expires);
    }
  });

  test("keeps the legacy expiry-in-last_refresh fallback for opaque tokens", () => {
    const auth = credentialsToAuthJson(credentials);
    delete auth.expires;
    auth.last_refresh = new Date(credentials.expires).toISOString();
    expect(authJsonToCredentials(auth).expires).toBe(credentials.expires);
  });

  test("preserves expiry without exposing a pool refresh token", () => {
    const auth = credentialsToAuthJson(credentials, { includeRefreshToken: false });
    expect(auth.tokens.refresh_token).toBe("");
    expect(authJsonToCredentials(auth).expires).toBe(credentials.expires);
  });

  test("seeds the black-box harness with separate refresh and expiry timestamps", () => {
    const before = Date.now();
    const auth = JSON.parse(codexOAuthAuthJson(JSON.stringify(credentials)));
    expect(Date.parse(auth.last_refresh)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(auth.last_refresh)).toBeLessThanOrEqual(Date.now());
    expect(authJsonToCredentials(auth)).toEqual(credentials);
  });
});
