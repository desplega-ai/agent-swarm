import { describe, expect, test } from "bun:test";
import {
  describeModelResolution,
  isSeededTaskProfile,
  MODEL_SOURCE_LABELS,
  modelSourceLabel,
  taskDisplayModel,
} from "./task-model-resolution";

describe("taskDisplayModel", () => {
  test("prefers the claim-time resolution over the requested model", () => {
    expect(taskDisplayModel({ model: "opus", resolvedModel: "claude-opus-5-5" })).toBe(
      "claude-opus-5-5",
    );
  });
  test("falls back to the requested model, then to nothing", () => {
    expect(taskDisplayModel({ model: "opus" })).toBe("opus");
    expect(taskDisplayModel({ modelTier: "smart" })).toBeUndefined();
  });
});

describe("describeModelResolution", () => {
  test("a tier task explains the requested tier, the layer and the alias", () => {
    expect(
      describeModelResolution({
        modelTier: "smart",
        resolvedModel: "claude-opus-5-5",
        modelSource: "tier-config",
        modelAlias: "latest:anthropic/opus",
      }),
    ).toEqual(["Requested: tier Smart", "Chosen by: Tier config", "Alias: latest:anthropic/opus"]);
  });

  test("an explicit model that resolved to itself has no Requested line", () => {
    expect(
      describeModelResolution({
        model: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
        modelSource: "model",
      }),
    ).toEqual(["Chosen by: Task model"]);
  });

  test("a profile task names the profile claim applied and the layer", () => {
    expect(
      describeModelResolution({
        modelTier: "smart",
        resolvedModel: "claude-opus-5-5",
        modelSource: "profile:tier-alias",
        resolvedProfile: "claude-smart",
      }),
    ).toEqual(["Requested: tier Smart", "Profile: claude-smart", "Chosen by: Tier (via profile)"]);
    expect(
      describeModelResolution({
        profile: "fast-review",
        resolvedModel: "claude-haiku-4-5",
        modelSource: "profile:task",
      }),
    ).toEqual(["Profile: fast-review", "Chosen by: Task profile"]);
  });

  test("unclaimed tasks have nothing to explain", () => {
    expect(describeModelResolution({ modelTier: "smart" })).toEqual([]);
  });

  test("every server modelSource has a label, and unknown ones pass through", () => {
    expect(Object.keys(MODEL_SOURCE_LABELS).sort()).toEqual([
      "fallback:cli-unsupported",
      "fallback:cli-unsupported:model",
      "model",
      "profile:agent-default",
      "profile:task",
      "profile:tier-alias",
      "tier-config",
      "tier-default",
      "worker-env",
    ]);
    expect(modelSourceLabel("fallback:cli-unsupported:model")).toBe(
      "Fallback (CLI rejected the task's own model)",
    );
    expect(modelSourceLabel("profile:tier-alias")).toBe("Tier (via profile)");
    expect(modelSourceLabel("profile:agent-default")).toBe("Agent default profile");
    expect(modelSourceLabel("something-new")).toBe("something-new");
  });
});

describe("isSeededTaskProfile", () => {
  test("catalog metadata overrides naming guesses", () => {
    expect(isSeededTaskProfile({ profile: "claude-smart" }, { seededFrom: null })).toBe(false);
    expect(isSeededTaskProfile({ profile: "Custom name" }, { seededFrom: "agent-config" })).toBe(
      true,
    );
    expect(isSeededTaskProfile({ profile: "Custom name" }, { seededFrom: "tier:smart" })).toBe(
      true,
    );
  });
  test("recognizes tier seeds while the catalog is unavailable", () => {
    expect(isSeededTaskProfile({ profile: "claude-smart" })).toBe(true);
    expect(isSeededTaskProfile({ profile: "codex-ultra" })).toBe(true);
    expect(isSeededTaskProfile({ profile: "review-smart" })).toBe(false);
  });
  test("matches migration names against the task model and effort", () => {
    expect(
      isSeededTaskProfile({
        resolvedProfile: "claude-opus-5-5-high",
        resolvedModel: "claude-opus-5-5",
        resolvedEffort: "high",
      }),
    ).toBe(true);
    expect(
      isSeededTaskProfile({
        profile: "codex-gpt-6.1-sol-medium",
        model: "gpt-6.1-sol",
        effort: "medium",
      }),
    ).toBe(true);
    expect(
      isSeededTaskProfile({
        profile: "pi-anthropic-claude-opus-5-5",
        model: "anthropic/claude-opus-5-5",
      }),
    ).toBe(true);
    expect(
      isSeededTaskProfile({
        profile: "claude-opus-5-5-low",
        model: "claude-opus-5-5",
        effort: "high",
      }),
    ).toBe(false);
    expect(
      isSeededTaskProfile({
        profile: "claude-other-high",
        model: "claude-opus-5-5",
        effort: "high",
      }),
    ).toBe(false);
    expect(isSeededTaskProfile({ profile: "Review Team" })).toBe(false);
  });
});
