import { describe, expect, test } from "bun:test";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  computeContextUsed,
  computeContextUsedUnified,
  getContextWindowSize,
} from "../utils/context-window";

describe("getContextWindowSize", () => {
  test("returns 1M for fable and mythos models", () => {
    expect(getContextWindowSize("claude-fable-5")).toBe(1_000_000);
    expect(getContextWindowSize("claude-mythos-5")).toBe(1_000_000);
    expect(getContextWindowSize("fable")).toBe(1_000_000);
    expect(getContextWindowSize("mythos")).toBe(1_000_000);
  });

  test("returns 1M for opus models", () => {
    expect(getContextWindowSize("claude-opus-4-8")).toBe(1_000_000);
    expect(getContextWindowSize("claude-opus-4-7")).toBe(1_000_000);
    expect(getContextWindowSize("claude-opus-4-6")).toBe(1_000_000);
    expect(getContextWindowSize("opus")).toBe(1_000_000);
  });

  test("returns 1M for sonnet models", () => {
    expect(getContextWindowSize("claude-sonnet-5")).toBe(1_000_000);
    expect(getContextWindowSize("claude-sonnet-4-6")).toBe(1_000_000);
    expect(getContextWindowSize("sonnet")).toBe(1_000_000);
  });

  test("returns 200K for haiku models", () => {
    expect(getContextWindowSize("claude-haiku-4-5")).toBe(200_000);
    expect(getContextWindowSize("haiku")).toBe(200_000);
  });

  test("returns 200K default for unknown models", () => {
    expect(getContextWindowSize("gpt-5")).toBe(200_000);
    expect(getContextWindowSize("unknown-model")).toBe(200_000);
    expect(getContextWindowSize("")).toBe(200_000);
  });

  test("returns default entry value", () => {
    expect(getContextWindowSize("default")).toBe(200_000);
  });

  test("Phase 4: dated full ids resolve via date-suffix stripping", () => {
    // The regression this fixes: pre-Phase 4 these all fell to the 200k
    // default, wildly understating opus/sonnet 4.x context.
    expect(getContextWindowSize("claude-sonnet-4-6-20251004")).toBe(1_000_000);
    expect(getContextWindowSize("claude-opus-4-7-20251201")).toBe(1_000_000);
    expect(getContextWindowSize("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("Phase 4: legacy 3.x family ids resolve", () => {
    expect(getContextWindowSize("claude-3-5-sonnet")).toBe(200_000);
    expect(getContextWindowSize("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(getContextWindowSize("claude-3-opus")).toBe(200_000);
  });
});

describe("computeContextUsed", () => {
  test("sums all token fields", () => {
    expect(
      computeContextUsed({
        input_tokens: 1000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 200,
      }),
    ).toBe(1700);
  });

  test("handles missing fields as zero", () => {
    expect(computeContextUsed({})).toBe(0);
    expect(computeContextUsed({ input_tokens: 100 })).toBe(100);
    expect(computeContextUsed({ cache_read_input_tokens: 50 })).toBe(50);
  });

  test("handles null fields as zero", () => {
    expect(
      computeContextUsed({
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ).toBe(0);
  });

  test("handles mix of values, nulls, and missing", () => {
    expect(
      computeContextUsed({
        input_tokens: 5000,
        cache_creation_input_tokens: null,
      }),
    ).toBe(5000);
  });
});

describe("computeContextUsedUnified (Phase 9 unified formula)", () => {
  test("sums input + cache_read + cache_create + output", () => {
    expect(
      computeContextUsedUnified({
        inputTokens: 1000,
        cacheReadTokens: 200,
        cacheCreateTokens: 300,
        outputTokens: 500,
      }),
    ).toBe(2000);
  });

  test("treats missing/null fields as zero", () => {
    expect(computeContextUsedUnified({})).toBe(0);
    expect(computeContextUsedUnified({ inputTokens: 100, outputTokens: null })).toBe(100);
  });
});

describe("clampContextPercent (Phase 9)", () => {
  test("returns the clamped percent for valid inputs", () => {
    expect(clampContextPercent(50_000, 200_000)).toBe(25);
    expect(clampContextPercent(0, 200_000)).toBe(0);
  });

  test("clamps to [0, 100]", () => {
    expect(clampContextPercent(500_000, 200_000)).toBe(100);
    expect(clampContextPercent(-10, 200_000)).toBe(0);
  });

  test("returns null for missing/zero/negative total (no divide-by-zero NaN)", () => {
    expect(clampContextPercent(100, 0)).toBeNull();
    expect(clampContextPercent(100, null)).toBeNull();
    expect(clampContextPercent(100, undefined)).toBeNull();
    expect(clampContextPercent(100, -1)).toBeNull();
  });
});

describe("CONTEXT_FORMULA constant", () => {
  test("is 'input-cache-output' so adapters stamp the same value on snapshots", () => {
    expect(CONTEXT_FORMULA).toBe("input-cache-output");
  });
});
