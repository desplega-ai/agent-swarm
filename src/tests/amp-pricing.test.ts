import { describe, expect, test } from "bun:test";
import { normalizeModelKey } from "../be/pricing-normalize";
import { recomputeSessionCost } from "../http/session-cost-recompute";
import { parseAmpThreadUsage } from "../providers/amp-adapter";
import { ampPricingLookup as lookupFromSeed } from "./amp-pricing-helpers";

describe("amp pricing", () => {
  test("model keys: vendor prefixes and OpenAI snapshot dates collapse, Fireworks paths and Anthropic dates stay", () => {
    expect(normalizeModelKey("amp", "openai/gpt-5-nano")).toBe("gpt-5-nano");
    expect(normalizeModelKey("amp", "gpt-5-nano-2025-08-07")).toBe("gpt-5-nano");
    expect(normalizeModelKey("amp", "Anthropic/claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(normalizeModelKey("amp", "accounts/fireworks/models/glm-5p3-flash")).toBe(
      "accounts/fireworks/models/glm-5p3-flash",
    );
    // Only amp collapses dated ids.
    expect(normalizeModelKey("codex", "gpt-5-nano-2025-08-07")).toBe("gpt-5-nano-2025-08-07");
  });

  test("the models Amp ran in live sessions price from the table", async () => {
    // Real ids from `amp threads export`: low -> Fireworks GLM, a pin -> OpenAI snapshot,
    // medium -> Opus 5.5, an Anthropic pin -> dated Haiku.
    const thread = parseAmpThreadUsage({
      messages: [
        {
          role: "assistant",
          usage: {
            model: "accounts/fireworks/models/glm-5p3-flash",
            inputTokens: 0,
            outputTokens: 4,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 37260,
          },
        },
        {
          role: "assistant",
          usage: {
            model: "gpt-5-nano-2025-08-07",
            inputTokens: 0,
            outputTokens: 26,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 41454,
          },
        },
        {
          role: "assistant",
          usage: {
            model: "claude-opus-5-5",
            inputTokens: 4,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 65602,
          },
        },
        {
          role: "assistant",
          usage: {
            model: "claude-haiku-4-5-20251001",
            inputTokens: 10,
            outputTokens: 43,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 48654,
          },
        },
      ],
    });
    const models = thread?.models ?? [];
    expect(models).toHaveLength(4);
    const result = await recomputeSessionCost(
      {
        provider: "amp",
        model: "claude-opus-5-5",
        harnessCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        models,
        atEpochMs: Date.now(),
      },
      lookupFromSeed(),
    );
    expect(result.costSource).toBe("pricing-table");
    const byModel = Object.fromEntries(
      (result.modelBreakdown ?? []).map((m) => [m.model, m.costUsd]),
    );
    // USD per 1M tokens, from the vendored models.dev snapshot.
    expect(byModel["accounts/fireworks/models/glm-5p3-flash"]).toBeCloseTo(
      (37260 * 0.15 + 4 * 0.5) / 1e6,
      9,
    );
    expect(byModel["gpt-5-nano-2025-08-07"]).toBeCloseTo((41454 * 0.05 + 26 * 0.4) / 1e6, 9);
    // Anthropic bills the cache write at its own rate.
    expect(byModel["claude-opus-5-5"]).toBeCloseTo((4 * 4 + 65602 * 5 + 5 * 20) / 1e6, 9);
    expect(byModel["claude-haiku-4-5-20251001"]).toBeCloseTo(
      (10 * 1 + 48654 * 1.25 + 43 * 5) / 1e6,
      9,
    );
    expect(result.totalCostUsd).toBeCloseTo(
      Object.values(byModel).reduce((sum, usd) => sum + usd, 0),
      9,
    );
  });

  test("a model the table does not know settles unpriced instead of free", async () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const result = await recomputeSessionCost(
      {
        provider: "amp",
        model: "accounts/fireworks/models/not-in-the-table",
        harnessCostUsd: 0,
        ...usage,
        models: [{ model: "accounts/fireworks/models/not-in-the-table", ...usage }],
        atEpochMs: Date.now(),
      },
      lookupFromSeed(),
    );
    expect(result.costSource).toBe("unpriced");
  });
});
