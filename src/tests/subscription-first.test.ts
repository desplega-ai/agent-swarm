/**
 * Subscription-first credential selection: one resolver reads each harness's
 * `chatgptSubscriptionTrait`. A codex_oauth pool slot serves OpenAI models
 * before OPENAI_API_KEY; with no slot the model keeps its API key.
 */

import { describe, expect, test } from "bun:test";
import { type CodexOAuthCredentialInfo, resolveSubscriptionFirst } from "../commands/runner";
import { resolveModel } from "../providers/pi-mono-adapter";

const slot: CodexOAuthCredentialInfo = {
  selection: {
    selected: "pool-slot-1",
    index: 1,
    total: 2,
    keySuffix: "abcde",
    keyType: "CODEX_OAUTH",
    isRateLimitFallback: false,
  },
  isPoolBacked: true,
};

/** A pool lookup that records each call's `poolOnly`. */
function pool(result: CodexOAuthCredentialInfo | null) {
  const calls: boolean[] = [];
  return {
    calls,
    resolve: async (poolOnly: boolean) => {
      calls.push(poolOnly);
      return result;
    },
  };
}

describe("pi (prefixed trait)", () => {
  test("a slot moves a bare or openai/ GPT model onto openai-codex", async () => {
    for (const model of ["gpt-5.6-luna", "openai/gpt-5.6-luna"]) {
      const p = pool(slot);
      expect(await resolveSubscriptionFirst("pi", model, p.resolve)).toEqual({
        model: "openai-codex/gpt-5.6-luna",
        oauthInfo: slot,
      });
      expect(p.calls).toEqual([true]);
    }
  });

  test("no slot keeps the model, which then resolves to pi-ai's openai provider", async () => {
    expect(await resolveSubscriptionFirst("pi", "gpt-5.6-luna", pool(null).resolve)).toEqual({
      model: "gpt-5.6-luna",
      oauthInfo: null,
    });
    // Bare ids used to stop at the first (anthropic) miss and run pi's default model.
    expect(resolveModel("gpt-5.6-luna", {})?.provider).toBe("openai");
  });

  test("an explicit openai-codex model stays as is with or without a slot", async () => {
    const model = "openai-codex/gpt-6.1-sol";
    expect(await resolveSubscriptionFirst("pi", model, pool(slot).resolve)).toEqual({
      model,
      oauthInfo: slot,
    });
    expect(await resolveSubscriptionFirst("pi", model, pool(null).resolve)).toEqual({
      model,
      oauthInfo: null,
    });
  });

  test("non-Codex-line models never touch the pool", async () => {
    const p = pool(slot);
    for (const model of [
      "",
      "sonnet",
      "gpt-4o",
      "openrouter/openai/gpt-5.6-luna",
      "nan/gpt-5.6-luna",
    ]) {
      expect(await resolveSubscriptionFirst("pi", model, p.resolve)).toEqual({
        model,
        oauthInfo: null,
      });
    }
    expect(p.calls).toEqual([]);
  });
});

describe("codex (native trait)", () => {
  test("a slot serves the model unchanged, auth.json fallback allowed", async () => {
    const p = pool(slot);
    expect(await resolveSubscriptionFirst("codex", "gpt-5.6-luna", p.resolve)).toEqual({
      model: "gpt-5.6-luna",
      oauthInfo: slot,
    });
    expect(p.calls).toEqual([false]);
  });

  test("no slot keeps the model on OPENAI_API_KEY", async () => {
    expect(await resolveSubscriptionFirst("codex", "gpt-5.6-luna", pool(null).resolve)).toEqual({
      model: "gpt-5.6-luna",
      oauthInfo: null,
    });
  });
});

describe("unsupported traits (opencode, claude)", () => {
  test("OpenAI models keep their API key even when the pool has a slot", async () => {
    for (const [harness, model] of [
      ["opencode", "openai/gpt-5.6-luna"],
      ["opencode", "gpt-5.6-luna"],
      ["claude", "sonnet"],
    ] as const) {
      const p = pool(slot);
      expect(await resolveSubscriptionFirst(harness, model, p.resolve)).toEqual({
        model,
        oauthInfo: null,
      });
      expect(p.calls).toEqual([]);
    }
  });
});
