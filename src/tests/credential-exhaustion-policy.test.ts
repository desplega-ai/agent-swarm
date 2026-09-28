import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchResolvedEnv } from "../commands/runner";
import {
  type ModelFamily,
  ModelWindowExhaustedError,
  resolveCredentialPools,
} from "../utils/credentials";

/**
 * T6 acceptance: with every key in a pool either key-wide rate-limited or
 * blocked by the requested model's weekly window, MODEL_WINDOW_EXHAUSTED_POLICY
 * (default "fail") throws at task admission instead of looping the worker
 * through the same exhausted key. "fallback" restores the legacy random pick.
 * Taskless configuration loads never throw.
 */
describe("resolveCredentialPools — model window exhaustion policy", () => {
  let server: ReturnType<typeof Bun.serve>;
  let apiUrl: string;
  const earliestResetAt = "2026-09-27T00:00:00.000Z";
  let configResponse: { configs: Array<{ key: string; value: string }> } = { configs: [] };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/config/resolved") {
          return Response.json(configResponse);
        }
        if (url.pathname === "/api/keys/available") {
          const model = url.searchParams.get("model");
          if (model === "fable") {
            return Response.json({
              success: true,
              availableIndices: [],
              totalKeys: 2,
              modelBlockedIndices: [0, 1],
              earliestModelResetAt: earliestResetAt,
            });
          }
          // sonnet (or any other model / no model): pool is fully available.
          return Response.json({ success: true, availableIndices: [0, 1], totalKeys: 2 });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    apiUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(() => {
    server.stop(true);
  });

  /**
   * Worker whose OAuth pool and default model (MODEL_OVERRIDE=fable) live only
   * in swarm config, with the Fable window exhausted on every key.
   */
  function withConfigOnlyCredentials(): void {
    configResponse = {
      configs: [
        { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok-a,tok-b" },
        { key: "MODEL_OVERRIDE", value: "claude-fable-5-1" },
        { key: "HARNESS_PROVIDER", value: "claude" },
      ],
    };
  }

  test("worker bootstrap: config-only fetchResolvedEnv resolves while the default model is exhausted", async () => {
    withConfigOnlyCredentials();
    const result = await fetchResolvedEnv(apiUrl, "key", "agent-fable-exhausted", {});
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^tok-[ab]$/);
    expect(result.env.MODEL_OVERRIDE).toBe("claude-fable-5-1");
    expect(result.credentialSelections).toHaveLength(1);
  });

  test("task admission: the exhausted default model still fails fast", async () => {
    withConfigOnlyCredentials();
    await expect(
      fetchResolvedEnv(apiUrl, "key", "agent-fable-exhausted", {}, undefined, {
        provider: "claude",
        enforceModelCapacity: true,
      }),
    ).rejects.toThrow(ModelWindowExhaustedError);
  });

  test("task admission: the same worker accepts a Sonnet task", async () => {
    withConfigOnlyCredentials();
    const result = await fetchResolvedEnv(
      apiUrl,
      "key",
      "agent-fable-exhausted",
      {},
      "claude-sonnet-5",
      { provider: "claude", enforceModelCapacity: true },
    );
    expect(result.credentialSelections).toHaveLength(1);
    expect(result.credentialSelections[0]!.isRateLimitFallback).toBe(false);
  });

  test("default policy (fail): throws ModelWindowExhaustedError with the reset time", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
    };
    await expect(
      resolveCredentialPools(env, {
        apiUrl,
        apiKey: "key",
        provider: "claude",
        model: "claude-fable-5-1",
        enforceModelCapacity: true,
      }),
    ).rejects.toThrow(ModelWindowExhaustedError);

    try {
      await resolveCredentialPools(env, {
        apiUrl,
        apiKey: "key",
        provider: "claude",
        model: "claude-fable-5-1",
        enforceModelCapacity: true,
      });
      throw new Error("expected ModelWindowExhaustedError");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelWindowExhaustedError);
      const typed = err as ModelWindowExhaustedError;
      expect(typed.model).toBe("fable" satisfies ModelFamily);
      expect(typed.window).toBe("seven_day_overage_included");
      expect(typed.earliestResetAt).toBe(earliestResetAt);
      expect(typed.keyType).toBe("CLAUDE_CODE_OAUTH_TOKEN");
      expect(typed.message).toContain("Fable");
      expect(typed.message).toContain(earliestResetAt);
    }
  });

  test("MODEL_WINDOW_EXHAUSTED_POLICY=fallback: starts a selection instead of throwing", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
      MODEL_WINDOW_EXHAUSTED_POLICY: "fallback",
    };
    const selections = await resolveCredentialPools(env, {
      apiUrl,
      apiKey: "key",
      provider: "claude",
      model: "claude-fable-5-1",
      enforceModelCapacity: true,
    });
    expect(selections.length).toBe(1);
    expect(selections[0]!.isRateLimitFallback).toBe(true);
  });

  test("a taskless configuration load (no enforceModelCapacity) never throws", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
    };
    const selections = await resolveCredentialPools(env, {
      apiUrl,
      apiKey: "key",
      provider: "claude",
      model: "claude-fable-5-1",
    });
    expect(selections.length).toBe(1);
    expect(selections[0]!.isRateLimitFallback).toBe(true);
  });

  test("a sonnet task on the same pool is unaffected (no Fable block)", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
    };
    const selections = await resolveCredentialPools(env, {
      apiUrl,
      apiKey: "key",
      provider: "claude",
      model: "claude-sonnet-5",
    });
    expect(selections.length).toBe(1);
    expect(selections[0]!.isRateLimitFallback).toBe(false);
  });
});
