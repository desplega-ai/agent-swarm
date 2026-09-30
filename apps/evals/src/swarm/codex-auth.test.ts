import { describe, expect, test } from "bun:test";
import {
  CODEX_AUTH_JSON_PATH,
  codexOAuthSource,
  installAuthJsonCommand,
  MIN_TOKEN_LIFETIME_MS,
  resolveCodexSubscriptionAuth,
} from "./codex-auth.ts";

const source = { apiUrl: "http://swarm", apiKey: "k", slot: 3 };
const NOW = 1_800_000_000_000;
const creds = (expires: number) => ({
  access: "access-token-value",
  refresh: "refresh-token-value",
  expires,
  accountId: "acct-1",
});

describe("codexOAuthSource", () => {
  test("needs both the URL and the key", () => {
    expect(codexOAuthSource({})).toBeNull();
    expect(codexOAuthSource({ EVALS_SWARM_API_URL: "http://s" })).toBeNull();
    expect(codexOAuthSource({ EVALS_SWARM_API_KEY: "k" })).toBeNull();
  });

  test("defaults to slot 0, trims a trailing slash, validates the slot", () => {
    expect(
      codexOAuthSource({ EVALS_SWARM_API_URL: "http://s/", EVALS_SWARM_API_KEY: "k" }),
    ).toEqual({ apiUrl: "http://s", apiKey: "k", slot: 0 });
    expect(
      codexOAuthSource({
        EVALS_SWARM_API_URL: "http://s",
        EVALS_SWARM_API_KEY: "k",
        EVALS_CODEX_OAUTH_SLOT: "2",
      })?.slot,
    ).toBe(2);
    expect(() =>
      codexOAuthSource({
        EVALS_SWARM_API_URL: "http://s",
        EVALS_SWARM_API_KEY: "k",
        EVALS_CODEX_OAUTH_SLOT: "-1",
      }),
    ).toThrow("EVALS_CODEX_OAUTH_SLOT");
  });
});

describe("resolveCodexSubscriptionAuth", () => {
  test("hands the sandbox the access token only: the refresh token is blank", async () => {
    const calls: unknown[][] = [];
    const auth = await resolveCodexSubscriptionAuth(source, {
      getValid: async (...args) => {
        calls.push(args);
        return creds(NOW + 5 * 24 * 3600_000);
      },
      now: () => NOW,
    });
    // refresh goes through the swarm's locked refresher, for the configured slot
    expect(calls).toEqual([["http://swarm", "k", 3]]);
    expect(auth.slot).toBe(3);
    expect(auth.authJson.auth_mode).toBe("chatgpt");
    expect(auth.authJson.tokens.access_token).toBe("access-token-value");
    expect(auth.authJson.tokens.refresh_token).toBe("");
    expect(JSON.stringify(auth.authJson)).not.toContain("refresh-token-value");
    expect(auth.accessToken).toBe("access-token-value");
  });

  test("a missing slot fails instead of falling back to a metered key", async () => {
    await expect(
      resolveCodexSubscriptionAuth(source, { getValid: async () => null, now: () => NOW }),
    ).rejects.toThrow("no codex_oauth_3 credential");
  });

  test("a token that would expire during the attempt is refused", async () => {
    await expect(
      resolveCodexSubscriptionAuth(source, {
        getValid: async () => creds(NOW + MIN_TOKEN_LIFETIME_MS - 1),
        now: () => NOW,
      }),
    ).rejects.toThrow("too soon");
  });
});

describe("installAuthJsonCommand", () => {
  test("writes the JSON base64-encoded, owned by worker, mode 600", () => {
    const authJson = {
      auth_mode: "chatgpt" as const,
      OPENAI_API_KEY: null,
      tokens: { id_token: "a", access_token: "a", refresh_token: "", account_id: "x'y" },
      last_refresh: "2026-10-01T00:00:00.000Z",
    };
    const cmd = installAuthJsonCommand(authJson);
    expect(cmd).not.toContain("x'y");
    const b64 = /echo (\S+) \| base64 -d/.exec(cmd)?.[1] ?? "";
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual(authJson);
    expect(cmd).toContain(`> ${CODEX_AUTH_JSON_PATH}`);
    expect(cmd).toContain(`chmod 600 ${CODEX_AUTH_JSON_PATH}`);
    expect(cmd).toContain("chown worker:worker");
  });
});
