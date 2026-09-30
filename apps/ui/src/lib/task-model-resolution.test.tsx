import { describe, expect, test } from "bun:test";
import {
  describeModelResolution,
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

  test("unclaimed tasks have nothing to explain", () => {
    expect(describeModelResolution({ modelTier: "smart" })).toEqual([]);
  });

  test("every server modelSource has a label, and unknown ones pass through", () => {
    expect(Object.keys(MODEL_SOURCE_LABELS).sort()).toEqual([
      "fallback:cli-unsupported",
      "model",
      "tier-config",
      "tier-default",
      "worker-env",
    ]);
    expect(modelSourceLabel("something-new")).toBe("something-new");
  });
});
