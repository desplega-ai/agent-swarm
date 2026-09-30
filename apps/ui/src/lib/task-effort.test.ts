import { describe, expect, test } from "bun:test";
import { tierRows } from "./model-tier-fixtures";
import { effortAllowed, SHARED_EFFORT_LEVELS, taskEffortOptions } from "./task-effort";

const base = {
  harness: "claude",
  tier: "",
  tiers: tierRows(),
  agentModel: undefined,
  lastUsedModel: undefined,
  catalog: null,
} as const;

describe("taskEffortOptions", () => {
  test("a Model Tier decides the model: its tier model for the agent's harness", () => {
    // claude smart = opus: no off, has xhigh.
    expect(taskEffortOptions({ ...base, tier: "smart" })).toEqual({
      kind: "levels",
      levels: ["low", "medium", "high", "xhigh"],
      guessed: false,
    });
    // smol = haiku: a thinking-budget model, off but no xhigh.
    expect(taskEffortOptions({ ...base, tier: "smol" })).toEqual({
      kind: "levels",
      levels: ["off", "low", "medium", "high"],
      guessed: false,
    });
    // codex takes max.
    const codex = taskEffortOptions({ ...base, harness: "codex", tier: "smart" });
    expect(codex.kind === "levels" && codex.levels).toContain("max");
  });

  test("the tier wins over the agent's own model", () => {
    const options = taskEffortOptions({
      ...base,
      tier: "smol",
      agentModel: "claude-opus-5-5",
    });
    expect(options.kind === "levels" && options.levels).toContain("off");
    expect(options.kind === "levels" && options.levels).not.toContain("xhigh");
  });

  test("with no tier, the agent's stored model decides", () => {
    const options = taskEffortOptions({ ...base, agentModel: "claude-haiku-4-5" });
    expect(options).toEqual({
      kind: "levels",
      levels: ["off", "low", "medium", "high"],
      guessed: false,
    });
    // ...then the model it last ran.
    const last = taskEffortOptions({ ...base, lastUsedModel: "claude-haiku-4-5" });
    expect(last.kind === "levels" && last.levels).toContain("off");
    // The stored model wins over the last run.
    const both = taskEffortOptions({
      ...base,
      agentModel: "claude-opus-5-5",
      lastUsedModel: "claude-haiku-4-5",
    });
    expect(both.kind === "levels" && both.levels).not.toContain("off");
  });

  test("no knowable model offers only the subset every harness takes", () => {
    const options = taskEffortOptions(base);
    expect(options).toEqual({ kind: "levels", levels: SHARED_EFFORT_LEVELS, guessed: true });
    expect(SHARED_EFFORT_LEVELS).toEqual(["low", "medium", "high"]);
    // An agent that has not reported its harness is unknown too.
    expect(taskEffortOptions({ ...base, harness: null }).kind).toBe("levels");
    // The tier rows are not loaded, or the harness has no row for the tier.
    expect(taskEffortOptions({ ...base, tier: "smart", tiers: undefined })).toMatchObject({
      guessed: true,
    });
    expect(taskEffortOptions({ ...base, harness: "pi", tier: "smart", tiers: [] })).toMatchObject({
      guessed: true,
    });
  });

  test("a last-run model the catalog cannot name is a guess, not 'no effort'", () => {
    expect(taskEffortOptions({ ...base, lastUsedModel: "Some: Reported Label" })).toMatchObject({
      kind: "levels",
      guessed: true,
    });
  });

  test("a stored or tier model the catalog cannot name takes no effort", () => {
    expect(taskEffortOptions({ ...base, agentModel: "my-custom-model" }).kind).toBe("unsupported");
    const tiers = tierRows({ "claude:smart": "my-custom-model" });
    expect(taskEffortOptions({ ...base, tier: "smart", tiers }).kind).toBe("unsupported");
  });

  test("a harness without effort control is off, with a reason", () => {
    for (const harness of ["acp", "dsh", "devin", "claude-managed"]) {
      const options = taskEffortOptions({
        ...base,
        harness,
        tier: "smart",
        agentModel: "claude-opus-5-5",
      });
      expect(options.kind).toBe("unsupported");
      expect(options.kind === "unsupported" && options.reason).toContain(
        "no reasoning effort control",
      );
    }
  });

  test("pi and opencode read the tier's provider-qualified model", () => {
    const pi = taskEffortOptions({ ...base, harness: "pi", tier: "smol" });
    // deepseek-v4.1-flash lists low and high only.
    expect(pi).toEqual({ kind: "levels", levels: ["low", "high"], guessed: false });
    const opencode = taskEffortOptions({ ...base, harness: "opencode", tier: "ultra" });
    expect(opencode.kind).toBe("levels");
  });
});

describe("effortAllowed", () => {
  test("keeps an offered level, drops any other", () => {
    const options = taskEffortOptions({ ...base, tier: "smol" });
    expect(effortAllowed(options, "off")).toBe("off");
    expect(effortAllowed(options, "xhigh")).toBe("");
    expect(effortAllowed(options, "")).toBe("");
    expect(effortAllowed({ kind: "unsupported", reason: "x" }, "high")).toBe("");
  });
});
