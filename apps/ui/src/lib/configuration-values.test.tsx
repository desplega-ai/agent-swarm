import { describe, expect, test } from "bun:test";
import { CONFIGURATION_GROUPS } from "./configuration-catalog";
import {
  convertDuration,
  DURATION_UNITS,
  formatDuration,
  isJsonObject,
  parseConfigList,
  preferredDurationUnit,
} from "./configuration-values";

describe("configuration duration storage", () => {
  test("converts human units to native values", () => {
    expect(convertDuration("10", "min", "ms")).toBe("600000");
    expect(convertDuration("2", "s", "ms")).toBe("2000");
    expect(convertDuration("240", "min", "h")).toBe("4");
    expect(convertDuration("48", "h", "days")).toBe("2");
  });
  test("round trips every unit pair, including fractions", () => {
    for (const native of DURATION_UNITS) {
      for (const display of DURATION_UNITS) {
        for (const value of ["0", "0.1", "1.5", "27", "90000"]) {
          const roundTrip = convertDuration(
            convertDuration(value, native, display),
            display,
            native,
          );
          expect(Number(roundTrip)).toBeCloseTo(Number(value), 8);
        }
      }
    }
  });
  test("fractional conversions avoid floating-point tails", () => {
    expect(convertDuration("0.1", "min", "ms")).toBe("6000");
    expect(convertDuration("1.5", "s", "ms")).toBe("1500");
    expect(convertDuration("500", "ms", "s")).toBe("0.5");
  });
  test("empty/unset remains empty, zero stays zero, unknown defaults stay readable", () => {
    for (const value of [undefined, "", " "]) expect(convertDuration(value, "ms", "s")).toBe("");
    expect(convertDuration("0", "days", "h")).toBe("0");
    expect(formatDuration("per-type (180/14/7)", "days")).toBe("per-type (180/14/7)");
    expect(convertDuration("invalid", "ms", "s")).toBe("invalid");
  });
  test("human defaults are unambiguous", () => {
    expect(formatDuration("600000", "ms")).toBe("10 min");
    expect(formatDuration("10000", "ms")).toBe("10 s");
    expect(formatDuration("30", "days")).toBe("30 days");
    expect(preferredDurationUnit("0", "days")).toBe("days");
  });
  test("every catalog duration declares its native unit", () => {
    const entries = CONFIGURATION_GROUPS.flatMap((group) => group.entries);
    const suffixes = { MS: "ms", SEC: "s", SECONDS: "s", MIN: "min", DAYS: "days" };
    for (const entry of entries.filter((entry) => entry.kind === "number")) {
      const suffix = entry.key.split("_").at(-1) as keyof typeof suffixes;
      expect(entry.unit).toBe(suffixes[suffix]);
    }
  });
});

test("CSV empty selections and unknown entries survive editing", () => {
  expect(parseConfigList("")).toEqual([]);
  expect(parseConfigList("llm, future-rater, llm,")).toEqual(["llm", "future-rater"]);
});

test("manifest editor accepts objects, rejects malformed JSON and scalar/array roots", () => {
  expect(isJsonObject('{"taskTypes":{"review":["get-task-details"]}}')).toBe(true);
  for (const value of ["", "{", "null", "[]", '"string"']) expect(isJsonObject(value)).toBe(false);
});
