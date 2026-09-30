import { describe, expect, test } from "bun:test";
import { CONFIGURATION_GROUPS, withModelTierGroup } from "./configuration-catalog";
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

describe("model tier rows come from the API, not the static catalog", () => {
  const tiers = [
    {
      provider: "claude",
      tier: "smart" as const,
      key: "MODEL_TIER_CLAUDE_SMART",
      defaultValue: "opus",
      configured: null,
      source: "tier-default" as const,
      resolvedModel: "opus",
      alias: null,
    },
    {
      provider: "claude-managed",
      tier: "smol" as const,
      key: "MODEL_TIER_CLAUDE_MANAGED_SMOL",
      defaultValue: "claude-haiku-4-5",
      configured: "latest:anthropic/haiku",
      source: "tier-config" as const,
      resolvedModel: "claude-haiku-4-5",
      alias: "latest:anthropic/haiku",
    },
  ];

  test("the static catalog carries no MODEL_TIER_<PROVIDER>_<TIER> rows", () => {
    const keys = CONFIGURATION_GROUPS.flatMap((group) => group.entries.map((entry) => entry.key));
    expect(
      keys.filter((key) => /^MODEL_TIER_[A-Z_]+_(SMOL|REGULAR|SMART|ULTRA)$/.test(key)),
    ).toEqual([]);
  });

  test("the live group follows Harness and takes defaults and resolutions from the API", () => {
    const groups = withModelTierGroup(CONFIGURATION_GROUPS, tiers);
    const ids = groups.map((group) => group.id);
    expect(ids.indexOf("model-tiers")).toBe(ids.indexOf("harness") + 1);
    const group = groups.find((g) => g.id === "model-tiers");
    expect(group?.entries.map((entry) => entry.key)).toEqual([
      "MODEL_TIER_CLAUDE_SMART",
      "MODEL_TIER_CLAUDE_MANAGED_SMOL",
    ]);
    expect(group?.entries[1]).toMatchObject({
      defaultValue: "claude-haiku-4-5",
      resolvesTo: { model: "claude-haiku-4-5", alias: "latest:anthropic/haiku" },
    });
  });

  test("a value that resolves to itself gets no Resolves to line", () => {
    const group = withModelTierGroup(CONFIGURATION_GROUPS, tiers).find(
      (g) => g.id === "model-tiers",
    );
    expect(group?.entries[0]?.resolvesTo).toBeUndefined();
  });

  test("a configured value that matched nothing is flagged as a fallback", () => {
    const group = withModelTierGroup(CONFIGURATION_GROUPS, [
      {
        provider: "codex",
        tier: "smol" as const,
        key: "MODEL_TIER_CODEX_SMOL",
        defaultValue: "gpt-5.6-luna",
        configured: "latest:openai/nope",
        source: "tier-default" as const,
        resolvedModel: "gpt-5.6-luna",
        alias: null,
      },
    ]).find((g) => g.id === "model-tiers");
    expect(group?.entries[0]?.resolvesTo).toMatchObject({ model: "gpt-5.6-luna", fellBack: true });
  });

  test("no tiers yet (loading, error, empty) leaves the catalog untouched", () => {
    expect(withModelTierGroup(CONFIGURATION_GROUPS, undefined)).toBe(CONFIGURATION_GROUPS);
    expect(withModelTierGroup(CONFIGURATION_GROUPS, [])).toBe(CONFIGURATION_GROUPS);
  });
});
