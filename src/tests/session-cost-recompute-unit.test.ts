// Pure-function edge cases for recomputeSessionCost — the golden suite
// anchors prod numbers end-to-end over HTTP; this file pins the branch
// behavior that is uneconomical to express through a server round-trip.

import { describe, expect, test } from "bun:test";
import { recomputeSessionCost } from "../http/session-cost-recompute";
import type { PricingProvider, PricingTokenClass } from "../types";

type RateBook = Partial<Record<string, number>>;

function lookupFrom(book: RateBook) {
  return async (
    provider: PricingProvider,
    model: string,
    tokenClass: PricingTokenClass,
    _at: number,
  ): Promise<number | null> => book[`${provider}:${model}:${tokenClass}`] ?? null;
}

const CLAUDE_OPUS: RateBook = {
  "claude:claude-opus-5:input": 5,
  "claude:claude-opus-5:output": 25,
  "claude:claude-opus-5:cached_input": 0.5,
  "claude:claude-opus-5:cache_write": 6.25,
  "claude:claude-opus-5:cache_write_1h": 10,
};

const BASE = {
  model: "claude-opus-5",
  harnessCostUsd: 42,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  atEpochMs: 1,
} as const;

describe("recomputeSessionCost — pure branch behavior", () => {
  test("0/0 split with a non-zero aggregate falls back to legacy 5m pricing, not $0", async () => {
    const result = await recomputeSessionCost(
      {
        ...BASE,
        provider: "claude",
        cacheWriteTokens: 1_000,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      lookupFrom(CLAUDE_OPUS),
    );
    expect(result.costSource).toBe("pricing-table");
    expect(result.totalCostUsd).toBe((1_000 * 6.25) / 1_000_000);
  });

  test("aggregate larger than the split is billed proportionally, not truncated to the split", async () => {
    // 100 of 1000 writes attributed 5m-only → the whole aggregate prices at
    // the 5m rate via the ratio; nothing is dropped.
    const result = await recomputeSessionCost(
      {
        ...BASE,
        provider: "claude",
        cacheWriteTokens: 1_000,
        cacheWrite5mTokens: 100,
        cacheWrite1hTokens: 0,
      },
      lookupFrom(CLAUDE_OPUS),
    );
    expect(result.totalCostUsd).toBe((1_000 * 6.25) / 1_000_000);
  });

  test("1h tokens without a cache_write_1h rate unprice the whole row", async () => {
    const { "claude:claude-opus-5:cache_write_1h": _omit, ...withoutOneHour } = CLAUDE_OPUS;
    const result = await recomputeSessionCost(
      {
        ...BASE,
        provider: "claude",
        cacheWriteTokens: 500,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 500,
      },
      lookupFrom(withoutOneHour),
    );
    expect(result.costSource).toBe("unpriced");
    expect(result.totalCostUsd).toBe(42);
  });

  test("anthropic-style input is billed as-is; openai-style subtracts cache reads", async () => {
    const anthropic = await recomputeSessionCost(
      { ...BASE, provider: "claude", inputTokens: 1_000, cacheReadTokens: 500_000 },
      lookupFrom(CLAUDE_OPUS),
    );
    expect(anthropic.totalCostUsd).toBe((1_000 * 5 + 500_000 * 0.5) / 1_000_000);

    const openai = await recomputeSessionCost(
      { ...BASE, model: "m", provider: "codex", inputTokens: 1_000, cacheReadTokens: 400 },
      lookupFrom({ "codex:m:input": 2, "codex:m:output": 10, "codex:m:cached_input": 0.2 }),
    );
    expect(openai.totalCostUsd).toBe((600 * 2 + 400 * 0.2) / 1_000_000);

    // Opencode reports input disjoint from cache reads (prod-verified:
    // input < cacheRead on every cached message) — no subtraction.
    const opencode = await recomputeSessionCost(
      { ...BASE, model: "m", provider: "opencode", inputTokens: 1_000, cacheReadTokens: 400_000 },
      lookupFrom({
        "opencode:m:input": 2,
        "opencode:m:output": 10,
        "opencode:m:cached_input": 0.2,
      }),
    );
    expect(opencode.totalCostUsd).toBe((1_000 * 2 + 400_000 * 0.2) / 1_000_000);
  });

  test("empty models[] behaves like no breakdown and stores no modelBreakdown", async () => {
    const result = await recomputeSessionCost(
      { ...BASE, provider: "claude", inputTokens: 100, models: [] },
      lookupFrom(CLAUDE_OPUS),
    );
    expect(result.costSource).toBe("pricing-table");
    expect(result.modelBreakdown).toBeUndefined();
  });

  test("missing runtime_hour rate unprices a claude-managed row with duration", async () => {
    const result = await recomputeSessionCost(
      {
        ...BASE,
        model: "claude-opus-5",
        provider: "claude-managed",
        inputTokens: 100,
        durationMs: 3_600_000,
      },
      lookupFrom({
        "claude-managed:claude-opus-5:input": 5,
        "claude-managed:claude-opus-5:output": 25,
      }),
    );
    expect(result.costSource).toBe("unpriced");
    expect(result.totalCostUsd).toBe(42);
  });

  test("no provider keeps the harness number and the posted breakdown", async () => {
    const models = [
      { model: "a", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    ];
    const result = await recomputeSessionCost({ ...BASE, models }, lookupFrom({}));
    expect(result.costSource).toBe("harness");
    expect(result.totalCostUsd).toBe(42);
    expect(result.modelBreakdown).toEqual(models);
  });
});
