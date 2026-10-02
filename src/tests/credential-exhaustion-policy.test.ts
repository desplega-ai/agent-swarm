import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
  /** Blocked indices returned for `model=fable`. The seat tests below override it. */
  const windowOnlyFableBlocks = { modelBlockedIndices: [0, 1], seatBlockedIndices: [] as number[] };
  let fableBlocks = windowOnlyFableBlocks;

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
              modelBlockedIndices: fableBlocks.modelBlockedIndices,
              seatBlockedIndices: fableBlocks.seatBlockedIndices,
              earliestModelResetAt: fableBlocks.modelBlockedIndices.length ? earliestResetAt : null,
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

  describe("seat blocks", () => {
    const fableTask = {
      apiUrl: "",
      apiKey: "key",
      provider: "claude",
      model: "claude-fable-5-1",
      enforceModelCapacity: true,
    };

    afterEach(() => {
      fableBlocks = windowOnlyFableBlocks;
    });

    test("default policy: throws and names seat blocks and window blocks", async () => {
      fableBlocks = { modelBlockedIndices: [0], seatBlockedIndices: [1] };
      const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b" };
      const err = await resolveCredentialPools(env, { ...fableTask, apiUrl }).catch((e) => e);
      expect(err).toBeInstanceOf(ModelWindowExhaustedError);
      const typed = err as ModelWindowExhaustedError;
      expect(typed.seatBlockedCount).toBe(1);
      expect(typed.modelBlockedCount).toBe(1);
      expect(typed.message).toBe(
        "No CLAUDE_CODE_OAUTH_TOKEN key can run Fable: 1 keys are on a seat without Fable, 1 keys have the Fable window exhausted until 2026-09-27T00:00:00.000Z. Re-dispatch with another model or modelTier.",
      );
    });

    test("MODEL_WINDOW_EXHAUSTED_POLICY=fallback: seat blocks still throw", async () => {
      fableBlocks = { modelBlockedIndices: [], seatBlockedIndices: [0, 1] };
      const env: Record<string, string | undefined> = {
        CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
        MODEL_WINDOW_EXHAUSTED_POLICY: "fallback",
      };
      const err = await resolveCredentialPools(env, { ...fableTask, apiUrl }).catch((e) => e);
      expect(err).toBeInstanceOf(ModelWindowExhaustedError);
      const typed = err as ModelWindowExhaustedError;
      expect(typed.earliestResetAt).toBeNull();
      expect(typed.message).toBe(
        "No CLAUDE_CODE_OAUTH_TOKEN key can run Fable: 2 keys are on a seat without Fable, 0 keys have the Fable window exhausted. Re-dispatch with another model or modelTier.",
      );
    });

    test("MODEL_WINDOW_EXHAUSTED_POLICY=fallback: window blocks alone still pick a key", async () => {
      const env: Record<string, string | undefined> = {
        CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
        MODEL_WINDOW_EXHAUSTED_POLICY: "fallback",
      };
      const selections = await resolveCredentialPools(env, { ...fableTask, apiUrl });
      expect(selections).toHaveLength(1);
      expect(selections[0]!.isRateLimitFallback).toBe(true);
    });

    test("MODEL_WINDOW_EXHAUSTED_POLICY=fallback: a mixed pool picks the Fable-capable key", async () => {
      fableBlocks = { modelBlockedIndices: [1], seatBlockedIndices: [0] };
      const env: Record<string, string | undefined> = {
        CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b",
        MODEL_WINDOW_EXHAUSTED_POLICY: "fallback",
      };
      const selections = await resolveCredentialPools(env, { ...fableTask, apiUrl });
      expect(selections).toHaveLength(1);
      expect(selections[0]!.index).toBe(1);
      expect(selections[0]!.isRateLimitFallback).toBe(true);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
    });

    test("MODEL_WINDOW_EXHAUSTED_POLICY=fallback: every key without a seat block stays reachable", async () => {
      fableBlocks = { modelBlockedIndices: [1, 2], seatBlockedIndices: [0] };
      const picked = new Set<number>();
      for (let run = 0; run < 50; run++) {
        const env: Record<string, string | undefined> = {
          CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b,tok-c",
          MODEL_WINDOW_EXHAUSTED_POLICY: "fallback",
        };
        const selections = await resolveCredentialPools(env, { ...fableTask, apiUrl });
        picked.add(selections[0]!.index);
      }
      expect([...picked].sort()).toEqual([1, 2]);
    });

    test("default policy: a key-wide rate limit next to a seat block picks the other key", async () => {
      fableBlocks = { modelBlockedIndices: [], seatBlockedIndices: [0] };
      const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b" };
      const selections = await resolveCredentialPools(env, { ...fableTask, apiUrl });
      expect(selections[0]!.index).toBe(1);
      expect(selections[0]!.isRateLimitFallback).toBe(true);
    });

    test("a taskless configuration load never throws on seat blocks", async () => {
      fableBlocks = { modelBlockedIndices: [], seatBlockedIndices: [0, 1] };
      const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b" };
      const selections = await resolveCredentialPools(env, {
        ...fableTask,
        apiUrl,
        enforceModelCapacity: undefined,
      });
      expect(selections).toHaveLength(1);
      expect(selections[0]!.seatBlockedIndices).toEqual([0, 1]);
    });

    test("a sonnet task on a seat-blocked Fable pool picks a key", async () => {
      fableBlocks = { modelBlockedIndices: [], seatBlockedIndices: [0, 1] };
      const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: "tok-a,tok-b" };
      const selections = await resolveCredentialPools(env, {
        ...fableTask,
        apiUrl,
        model: "claude-sonnet-5",
      });
      expect(selections).toHaveLength(1);
      expect(selections[0]!.isRateLimitFallback).toBe(false);
    });
  });
});
