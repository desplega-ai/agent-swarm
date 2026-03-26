import { describe, expect, test } from "bun:test";
import { computeContextUsed, getContextWindowSize } from "../utils/context-window";

describe("getContextWindowSize", () => {
  test("returns 1M for opus models", () => {
    expect(getContextWindowSize("claude-opus-4-6")).toBe(1_000_000);
    expect(getContextWindowSize("opus")).toBe(1_000_000);
  });

  test("returns 1M for sonnet models", () => {
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
