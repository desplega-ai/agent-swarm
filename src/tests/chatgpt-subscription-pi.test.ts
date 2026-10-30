/**
 * pi on the ChatGPT subscription pool (`openai-codex/<id>` models): the
 * credential handed to pi never carries the pool's refresh token, the gate
 * reports ready on pool slots, and the model resolves to pi-ai's ChatGPT
 * backend provider.
 */

import { describe, expect, test } from "bun:test";
import { CodexOAuthRefreshError } from "../providers/codex-oauth/storage";
import {
  chatgptSubscriptionAuthFailure,
  loadChatgptSubscriptionCredential,
} from "../providers/codex-oauth/subscription";
import {
  checkPiMonoCredentials,
  createPiRuntimeAuth,
  resolveModel,
} from "../providers/pi-mono-adapter";
import { supportedReasoningLevels } from "../providers/reasoning-effort";
import { isCodexAuthFailureReason } from "../utils/codex-auth-failure";

const CREDS = {
  access: "subscription-access-token-for-tests",
  refresh: "pool-refresh-token-must-not-leak",
  expires: Date.now() + 24 * 60 * 60 * 1000,
  accountId: "acct-subscription",
};
const CONFIG = {
  apiUrl: "http://localhost:3013",
  apiKey: "test-key",
  codexSlot: 2,
  model: "openai-codex/gpt-5.6-sol",
};
const noFiles = { existsSync: () => false };

describe("loadChatgptSubscriptionCredential", () => {
  test("revalidates the runner's slot and blanks the refresh token", async () => {
    let slotSeen: number | undefined;
    const creds = await loadChatgptSubscriptionCredential(CONFIG, {
      getValid: async (_url, _key, slot) => {
        slotSeen = slot;
        return CREDS;
      },
    });
    expect(slotSeen).toBe(2);
    expect(creds).toEqual({ ...CREDS, refresh: "" });
  });

  test("no pool slot is an auth error, not a silent fallback", async () => {
    await expect(
      loadChatgptSubscriptionCredential({ ...CONFIG, codexSlot: undefined }),
    ).rejects.toThrow("[auth-error]");
  });

  test("a rejected refresh carries the codex pool failure reason", async () => {
    await expect(
      loadChatgptSubscriptionCredential(CONFIG, {
        getValid: async () => {
          throw new CodexOAuthRefreshError(2, "refresh_rejected", "abcde", 401, "revoked");
        },
      }),
    ).rejects.toThrow("Codex pool slot 2 [...abcde] revalidation failed: refresh rejected");
  });

  test("a quarantined slot fails fast", async () => {
    await expect(
      loadChatgptSubscriptionCredential(CONFIG, { getValid: async () => null }),
    ).rejects.toThrow("no credentials found in config store");
  });
});

describe("checkPiMonoCredentials with a subscription model", () => {
  const model = { MODEL_OVERRIDE: "openai-codex/gpt-5.6-sol" };

  test("ready when the pool has slots", async () => {
    const status = await checkPiMonoCredentials(
      { ...model, CODEX_OAUTH_POOL_SLOTS: "2" },
      { homeDir: "/home/test", fs: noFiles },
    );
    expect(status).toEqual({ ready: true, missing: [], satisfiedBy: "env" });
  });

  test("not ready without slots, even with other keys or a pi auth.json", async () => {
    const status = await checkPiMonoCredentials(
      { ...model, OPENAI_API_KEY: "sk-test" },
      { homeDir: "/home/test", fs: { existsSync: () => true } },
    );
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["CODEX_OAUTH"]);
  });

  test("pool slots alone satisfy the permissive (no MODEL_OVERRIDE) check", async () => {
    const status = await checkPiMonoCredentials(
      { CODEX_OAUTH_POOL_SLOTS: "1" },
      { homeDir: "/home/test", fs: noFiles },
    );
    expect(status.ready).toBe(true);
  });
});

describe("pi model resolution and auth", () => {
  test("a shipped id resolves to pi-ai's openai-codex model", () => {
    const model = resolveModel("openai-codex/gpt-5.6-sol", {});
    expect({ provider: model?.provider, id: model?.id }).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    });
  });

  test("a catalog id pi-ai does not ship reuses the provider's transport", () => {
    const model = resolveModel("openai-codex/gpt-7-test", {});
    expect({ provider: model?.provider, id: model?.id, api: model?.api }).toEqual({
      provider: "openai-codex",
      id: "gpt-7-test",
      api: "openai-codex-responses",
    });
  });

  test("the session runtime authenticates openai-codex from memory with no refresh token", async () => {
    const runtime = await createPiRuntimeAuth({}, undefined, { ...CREDS, refresh: "" });
    const auth = await runtime.getAuth("openai-codex");
    expect(auth?.auth.apiKey).toBe(CREDS.access);
    const listed = await runtime.listCredentials();
    expect(listed).toContainEqual({ providerId: "openai-codex", type: "oauth" });
  });
});

describe("chatgptSubscriptionAuthFailure", () => {
  const revoked =
    "Your authentication token has been invalidated. Please try signing in again. (token_invalidated)";

  test("a rejected subscription login mid-run is a counted auth failure for its slot", () => {
    const reason = chatgptSubscriptionAuthFailure(revoked, CONFIG);
    expect(reason).toStartWith("[auth-error] Codex pool slot 2 authentication failed");
    expect(reason).toContain(revoked);
    expect(isCodexAuthFailureReason(reason)).toBe(true);
    expect(
      isCodexAuthFailureReason(chatgptSubscriptionAuthFailure("401 Unauthorized", CONFIG)),
    ).toBe(true);
  });

  test("the backend's 401 for an unparseable access token counts too", () => {
    // Live body for a slot holding a malformed access token (pi surfaces it without the status).
    const reason = chatgptSubscriptionAuthFailure(
      "Could not parse your authentication token. Please try signing in again.",
      CONFIG,
    );
    expect(isCodexAuthFailureReason(reason)).toBe(true);
  });

  test("other errors, models and slotless sessions are left alone", () => {
    expect(chatgptSubscriptionAuthFailure("Codex stream ended without a stop reason", CONFIG)).toBe(
      undefined,
    );
    expect(
      chatgptSubscriptionAuthFailure(revoked, { ...CONFIG, model: "openai/gpt-5.6-sol" }),
    ).toBe(undefined);
    expect(chatgptSubscriptionAuthFailure(revoked, { ...CONFIG, codexSlot: undefined })).toBe(
      undefined,
    );
  });
});

describe("subscription effort levels on the worker", () => {
  test("a mixed-case prefix keeps the openai levels", () => {
    const levels = supportedReasoningLevels("pi", "OpenAI-Codex/gpt-5.6-sol");
    expect(levels.length).toBeGreaterThan(0);
    expect(levels).toEqual(supportedReasoningLevels("pi", "openai/gpt-5.6-sol"));
  });
});
