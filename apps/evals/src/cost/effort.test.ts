import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../types.ts";
import { getResolutionCatalog } from "./catalog.ts";
import { configModelId, effortError, effortLevelsForConfig, isEffortLevel } from "./effort.ts";

// Real catalog snapshot: the levels come from the shared rule, not a list here.
const catalog = await getResolutionCatalog();

const haiku: HarnessConfig = { id: "claude-haiku", provider: "claude", model: "claude-haiku-4-5" };
const opusAlias: HarnessConfig = {
  id: "claude-opus",
  provider: "claude",
  modelAlias: "latest:anthropic/opus",
};
const sol: HarnessConfig = { id: "codex-sol", provider: "codex", model: "gpt-5.6-sol" };
const flash: HarnessConfig = {
  id: "pi-deepseek-flash",
  provider: "pi",
  model: "openrouter/deepseek/deepseek-v4-flash",
};
const harnessDefault: HarnessConfig = { id: "claude-default", provider: "claude" };

describe("effort levels for a config", () => {
  test("come from the catalog facts of the harness + model pair", () => {
    // Claude gains the synthetic `off` only on a model that still has a thinking budget.
    expect(effortLevelsForConfig(haiku, catalog)).toContain("off");
    expect(effortLevelsForConfig(haiku, catalog)).not.toContain("max");
    expect(effortLevelsForConfig(sol, catalog)).toContain("max");
    expect(effortLevelsForConfig(flash, catalog).length).toBeGreaterThan(0);
  });

  test("the same model takes different levels on different harnesses", () => {
    const asPi = effortLevelsForConfig(flash, catalog);
    const asOpencode = effortLevelsForConfig({ ...flash, provider: "opencode" }, catalog);
    expect(asOpencode).toEqual(asPi);
    expect(effortLevelsForConfig({ ...sol, provider: "claude" }, catalog)).toEqual([]);
  });

  test("an alias config uses the model it resolves to today", () => {
    const resolved = configModelId(opusAlias, catalog);
    expect(resolved).toStartWith("claude-opus");
    expect(effortLevelsForConfig(opusAlias, catalog)).toEqual(
      effortLevelsForConfig({ ...opusAlias, modelAlias: undefined, model: resolved }, catalog),
    );
  });

  test("a harness-default config and an unlisted model take none", () => {
    expect(configModelId(harnessDefault, catalog)).toBeUndefined();
    expect(effortLevelsForConfig(harnessDefault, catalog)).toEqual([]);
    expect(effortLevelsForConfig({ ...haiku, model: "claude-not-a-model" }, catalog)).toEqual([]);
  });
});

describe("effortError", () => {
  test("null for a supported level", () => {
    const [level] = effortLevelsForConfig(sol, catalog);
    expect(level).toBeDefined();
    expect(effortError(sol, level as NonNullable<typeof level>, catalog)).toBeNull();
  });

  test("names the pair and lists what it does take", () => {
    const error = effortError(haiku, "max", catalog);
    expect(error).toContain("claude + claude-haiku-4-5");
    expect(error).toContain('"max"');
    expect(error).toContain("supported: off");
  });

  test("a model that takes no effort says so", () => {
    expect(effortError({ ...haiku, model: "claude-not-a-model" }, "high", catalog)).toContain(
      "takes no reasoning effort",
    );
  });

  test("a harness-default config cannot be checked", () => {
    expect(effortError(harnessDefault, "high", catalog)).toContain("pin a model first");
  });
});

describe("isEffortLevel", () => {
  test("accepts the closed enum only", () => {
    expect(isEffortLevel("xhigh")).toBe(true);
    expect(isEffortLevel("off")).toBe(true);
    for (const bad of ["", "HIGH", "minimal", "default", null, undefined, 3]) {
      expect(isEffortLevel(bad)).toBe(false);
    }
  });
});
