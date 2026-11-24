import { describe, expect, test } from "bun:test";
import { effectiveModelLimits } from "../utils/provider-model-limits";

describe("effective route limits", () => {
  const discovered = { input: 922000, output: 128000 };
  test("does not guess a combined window", () => {
    expect(effectiveModelLimits({ discovered })).toMatchObject({
      input: 922000,
      output: 128000,
      context: 922000,
      contextBasis: "input-conservative",
    });
    expect(effectiveModelLimits({ discovered, semantics: "input-plus-output" })).toMatchObject({
      context: 1050000,
      contextBasis: "configured-input-plus-output",
    });
  });
  test("explicit policy wins but cannot bypass known gateway ceilings", () => {
    expect(effectiveModelLimits({ discovered, explicit: { context: 1000000 } })).toMatchObject({
      context: 1000000,
      contextBasis: "explicit",
    });
    expect(() => effectiveModelLimits({ discovered, explicit: { input: 1000000 } })).toThrow(
      "gateway",
    );
    expect(() => effectiveModelLimits({ discovered, explicit: { output: 200000 } })).toThrow(
      "gateway",
    );
    expect(() =>
      effectiveModelLimits({
        discovered: { ...discovered, context: 950000 },
        explicit: { context: 1000000 },
      }),
    ).toThrow("gateway");
  });
  test("catalog is fallback, not a route ceiling or a replacement for partial discovery", () => {
    expect(effectiveModelLimits({ discovered, catalog: { context: 200000 } }).context).toBe(922000);
    expect(effectiveModelLimits({ catalog: { context: 500000, output: 32000 } })).toMatchObject({
      context: 500000,
      output: 32000,
      source: "catalog",
    });
    expect(
      effectiveModelLimits({ discovered: { input: 900000 }, catalog: { output: 128000 } }).output,
    ).toBeUndefined();
    expect(effectiveModelLimits({})).toMatchObject({ context: 200000, source: "legacy" });
  });
  test("rejects contradictory or invalid policy without echoing values", () => {
    for (const n of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => effectiveModelLimits({ explicit: { input: n } })).toThrow("Invalid");
    }
    expect(() =>
      effectiveModelLimits({ explicit: { input: 1000, context: 900, output: 200 } }),
    ).toThrow();
    expect(() =>
      effectiveModelLimits({
        discovered: { input: Number.MAX_SAFE_INTEGER, output: 1 },
        semantics: "input-plus-output",
      }),
    ).toThrow();
  });
});
