import { describe, expect, test } from "bun:test";
import {
  activeModelBlock,
  FABLE_WINDOW,
  isModelScopedWindow,
  modelFamilyOf,
  OPUS_WINDOW,
  parseModelLimitMessage,
  SONNET_WINDOW,
  windowForModelFamily,
} from "../utils/model-rate-limit-windows";

describe("modelFamilyOf", () => {
  test.each([
    ["claude-fable-5-1", "fable"],
    ["fable", "fable"],
    ["opus", "opus"],
    ["claude-sonnet-5", "sonnet"],
    ["haiku", "haiku"],
    ["claude-fable-5-2", "fable"],
    ["claude-fable-6", "fable"],
    ["claude-fable-6-20270115", "fable"],
    ["anthropic/claude-fable-7", "fable"],
    ["claude-fable-5-1[1m]", "fable"],
    ["FABLE", "fable"],
    ["claude-opus-6-1", "opus"],
    ["claude-sonnet-6", "sonnet"],
    ["claude-haiku-5", "haiku"],
  ] as const)("modelFamilyOf(%s) is %s", (model, family) => {
    expect(modelFamilyOf(model)).toBe(family);
  });

  test.each([
    "gpt-5.1",
    "google/gemini-3-flash-preview",
  ])("modelFamilyOf(%s) is undefined", (model) => {
    expect(modelFamilyOf(model)).toBeUndefined();
  });

  test("modelFamilyOf('') is undefined", () => {
    expect(modelFamilyOf("")).toBeUndefined();
  });

  test("modelFamilyOf(undefined) is undefined", () => {
    expect(modelFamilyOf(undefined)).toBeUndefined();
  });
});

describe("windowForModelFamily", () => {
  test("fable maps to the Fable window constant", () => {
    expect(windowForModelFamily("fable")).toBe(FABLE_WINDOW);
    expect(FABLE_WINDOW).toBe("seven_day_overage_included");
  });

  test("opus and sonnet map to their window constants", () => {
    expect(windowForModelFamily("opus")).toBe(OPUS_WINDOW);
    expect(windowForModelFamily("sonnet")).toBe(SONNET_WINDOW);
  });

  test("haiku has no weekly window", () => {
    expect(windowForModelFamily("haiku")).toBeUndefined();
  });
});

describe("parseModelLimitMessage", () => {
  test("matches the Fable failure text", () => {
    expect(
      parseModelLimitMessage(
        "You've reached your Fable limit. Switch to another model to continue.",
      ),
    ).toBe("fable");
  });

  test("does not match the generic weekly-limit text", () => {
    expect(
      parseModelLimitMessage("You've hit your weekly limit · resets May 28, 5pm (UTC)"),
    ).toBeUndefined();
  });

  test("matches Opus and Sonnet variants case-insensitively", () => {
    expect(parseModelLimitMessage("you've reached your opus limit.")).toBe("opus");
    expect(parseModelLimitMessage("You've reached your SONNET limit.")).toBe("sonnet");
  });
});

describe("activeModelBlock", () => {
  test("returns the entry when resetsAt is in the future and status is rejected", () => {
    const nowMs = Date.now();
    const resetsAtSec = Math.floor(nowMs / 1000) + 3600;
    const result = activeModelBlock(
      { [FABLE_WINDOW]: { status: "rejected", resetsAt: resetsAtSec } },
      "fable",
      nowMs,
    );
    expect(result).toEqual({ window: FABLE_WINDOW, resetsAt: resetsAtSec });
  });

  test("returns undefined when resetsAt is in the past", () => {
    const nowMs = Date.now();
    const resetsAtSec = Math.floor(nowMs / 1000) - 3600;
    const result = activeModelBlock(
      { [FABLE_WINDOW]: { status: "rejected", resetsAt: resetsAtSec } },
      "fable",
      nowMs,
    );
    expect(result).toBeUndefined();
  });

  test("returns undefined for a non-rejected status", () => {
    const nowMs = Date.now();
    const resetsAtSec = Math.floor(nowMs / 1000) + 3600;
    const result = activeModelBlock(
      { [FABLE_WINDOW]: { status: "allowed_warning", resetsAt: resetsAtSec } },
      "fable",
      nowMs,
    );
    expect(result).toBeUndefined();
  });

  test("returns undefined for haiku (no window)", () => {
    const nowMs = Date.now();
    const result = activeModelBlock({}, "haiku", nowMs);
    expect(result).toBeUndefined();
  });

  test("returns undefined when windows is undefined", () => {
    expect(activeModelBlock(undefined, "fable", Date.now())).toBeUndefined();
  });
});

describe("isModelScopedWindow", () => {
  test.each([FABLE_WINDOW, OPUS_WINDOW, SONNET_WINDOW])("%s is model-scoped", (type) => {
    expect(isModelScopedWindow(type)).toBe(true);
  });

  test.each([
    "five_hour",
    "seven_day",
    "overage",
    "unknown_window",
  ])("%s is not model-scoped", (type) => {
    expect(isModelScopedWindow(type)).toBe(false);
  });

  test("prototype-chain properties are not model-scoped (own-property check, not `in`)", () => {
    expect(isModelScopedWindow("toString")).toBe(false);
    expect(isModelScopedWindow("constructor")).toBe(false);
    expect(isModelScopedWindow("hasOwnProperty")).toBe(false);
  });
});
