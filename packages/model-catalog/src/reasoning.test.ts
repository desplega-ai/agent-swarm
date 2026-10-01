import { describe, expect, test } from "bun:test";
import {
  claudeCatalogModelId,
  modelDisplayName,
  nearestReasoningLevel,
  REASONING_EFFORT_LEVELS,
  reasoningLevelsFor,
  reasoningLevelsForModel,
} from "./index.ts";

const effort = (...values: string[]) => ({
  reasoning: true,
  reasoning_options: [{ type: "effort", values }],
});

describe("reasoningLevelsFor", () => {
  test("no facts, a non-reasoning model, or a harness without effort control gives no levels", () => {
    expect(reasoningLevelsFor("claude", "x", undefined)).toEqual([]);
    expect(reasoningLevelsFor("claude", "x", null)).toEqual([]);
    expect(reasoningLevelsFor("claude", "x", { reasoning: false })).toEqual([]);
    expect(reasoningLevelsFor("claude", "x", { ...effort("low"), reasoning: false })).toEqual([]);
    for (const harness of ["acp", "devin", "claude-managed", ""]) {
      expect(reasoningLevelsFor(harness, "x", effort("low", "high"))).toEqual([]);
    }
  });

  test("dsh keeps max; off only on the direct DeepSeek route, where it is a real toggle", () => {
    const facts = {
      ...effort("low", "high", "max"),
      reasoning_options: [{ type: "toggle" }, ...effort("low", "high", "max").reasoning_options],
    };
    expect(reasoningLevelsFor("dsh", "deepseek-v4-pro", facts)).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
    expect(reasoningLevelsFor("dsh", "deepseek/deepseek-v4.1-flash", facts)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(reasoningLevelsFor("dsh", "deepseek-v4-pro", effort("high", "max"))).toEqual([
      "high",
      "max",
    ]);
  });

  test("dsh model strings resolve to the openrouter or deepseek catalog section", () => {
    const catalog = {
      openrouter: { models: { "deepseek/deepseek-v4.1-flash": effort("low", "high") } },
      deepseek: { models: { "deepseek-v4-pro": effort("high", "max") } },
    };
    expect(
      reasoningLevelsForModel("dsh", "openrouter/deepseek/deepseek-v4.1-flash", catalog),
    ).toEqual(["low", "high"]);
    expect(reasoningLevelsForModel("dsh", "deepseek-v4-pro", catalog)).toEqual(["high", "max"]);
    expect(reasoningLevelsForModel("dsh", "deepseek-flash", catalog)).toEqual([]);
  });

  test("effort values map to the enum in canonical order; none is off, minimal is dropped", () => {
    expect(
      reasoningLevelsFor("codex", "x", effort("high", "minimal", "none", "low", "medium")),
    ).toEqual(["off", "low", "medium", "high"]);
  });

  test("a reasoning model with no usable effort option gets low, medium, high", () => {
    expect(reasoningLevelsFor("pi", "x", { reasoning: true })).toEqual(["low", "medium", "high"]);
    expect(
      reasoningLevelsFor("pi", "x", { reasoning: true, reasoning_options: [{ type: "effort" }] }),
    ).toEqual(["low", "medium", "high"]);
    expect(reasoningLevelsFor("pi", "x", effort("minimal"))).toEqual(["low", "medium", "high"]);
  });

  test("max is codex-only", () => {
    const facts = effort("low", "high", "xhigh", "max");
    expect(reasoningLevelsFor("codex", "gpt-x", facts)).toEqual(["low", "high", "xhigh", "max"]);
    for (const harness of ["claude", "pi", "opencode"]) {
      expect(reasoningLevelsFor(harness, "m", facts)).toEqual(["low", "high", "xhigh"]);
    }
  });

  test("claude gains off only when the model exposes a numeric thinking budget", () => {
    const budget = {
      reasoning: true,
      reasoning_options: [{ type: "budget_tokens" }, { type: "effort", values: ["low", "high"] }],
    };
    expect(reasoningLevelsFor("claude", "claude-haiku-4-5", budget)).toEqual([
      "off",
      "low",
      "high",
    ]);
    expect(reasoningLevelsFor("claude", "claude-opus-5-5", effort("low", "high"))).toEqual([
      "low",
      "high",
    ]);
    // Only claude has the synthetic off.
    expect(reasoningLevelsFor("codex", "m", budget)).toEqual(["low", "high"]);
  });

  test("codex naming rules fill gaps the catalog leaves", () => {
    expect(reasoningLevelsFor("codex", "gpt-5.1-codex", effort("low", "high", "xhigh"))).toEqual([
      "low",
      "high",
    ]);
    expect(reasoningLevelsFor("codex", "gpt-5.1-codex-max", effort("low", "high"))).toEqual([
      "low",
      "high",
      "xhigh",
    ]);
  });

  test("the enum is closed and ordered", () => {
    expect(REASONING_EFFORT_LEVELS).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("claudeCatalogModelId", () => {
  const models = {
    "claude-opus-5": { release_date: "2026-05-01" },
    "claude-opus-5-5": { release_date: "2026-09-22" },
    "claude-sonnet-5-5": { release_date: "2026-09-28" },
    "claude-haiku-4-5": { release_date: "2025-10-15" },
    "claude-haiku-4-5-20251001": { release_date: "2025-10-01" },
  };

  test("a CLI shortname is the newest undated model of its family", () => {
    expect(claudeCatalogModelId("opus", models)).toBe("claude-opus-5-5");
    expect(claudeCatalogModelId("sonnet", models)).toBe("claude-sonnet-5-5");
    expect(claudeCatalogModelId("haiku", models)).toBe("claude-haiku-4-5");
  });

  test("a catalog id, an unknown name, and an empty value come back unchanged", () => {
    expect(claudeCatalogModelId("claude-opus-5", models)).toBe("claude-opus-5");
    expect(claudeCatalogModelId("claude-haiku-4-5-20251001", models)).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(claudeCatalogModelId("gpt-5", models)).toBe("gpt-5");
    expect(claudeCatalogModelId("", models)).toBe("");
    expect(claudeCatalogModelId("opus", undefined)).toBe("opus");
  });

  test("a shortname that is also a catalog id stays that id", () => {
    expect(claudeCatalogModelId("opus", { opus: {}, "claude-opus-5-5": {} })).toBe("opus");
  });
});

describe("reasoningLevelsForModel", () => {
  const catalog = {
    anthropic: {
      models: {
        "claude-opus-5-5": { ...effort("low", "high", "xhigh"), release_date: "2026-09-22" },
        "claude-haiku-4-5": {
          reasoning: true,
          reasoning_options: [
            { type: "budget_tokens" },
            { type: "effort", values: ["low", "high"] },
          ],
          release_date: "2025-10-15",
        },
        "claude-plain": { reasoning: false, release_date: "2025-01-01" },
      },
    },
    openai: { models: { "gpt-5.6-sol": effort("low", "high", "max") } },
    openrouter: { models: { "google/gemini-3-flash-preview": effort("low", "medium", "high") } },
  };

  test("claude reads the anthropic section and resolves CLI shortnames", () => {
    expect(reasoningLevelsForModel("claude", "claude-opus-5-5", catalog)).toEqual([
      "low",
      "high",
      "xhigh",
    ]);
    expect(reasoningLevelsForModel("claude", "opus", catalog)).toEqual(["low", "high", "xhigh"]);
    expect(reasoningLevelsForModel("claude", "claude-haiku-4-5", catalog)).toEqual([
      "off",
      "low",
      "high",
    ]);
  });

  test("codex reads the openai section and keeps max", () => {
    expect(reasoningLevelsForModel("codex", "gpt-5.6-sol", catalog)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("pi and opencode split the provider off on the first slash only", () => {
    for (const harness of ["pi", "opencode"]) {
      expect(
        reasoningLevelsForModel(harness, "openrouter/google/gemini-3-flash-preview", catalog),
      ).toEqual(["low", "medium", "high"]);
      expect(reasoningLevelsForModel(harness, "google/gemini-3-flash-preview", catalog)).toEqual(
        [],
      );
      expect(reasoningLevelsForModel(harness, "gemini-3-flash-preview", catalog)).toEqual([]);
    }
  });

  test("unknown models, non-reasoning models, missing input and other harnesses give none", () => {
    expect(reasoningLevelsForModel("claude", "claude-plain", catalog)).toEqual([]);
    expect(reasoningLevelsForModel("claude", "claude-unlisted", catalog)).toEqual([]);
    expect(reasoningLevelsForModel("claude", "", catalog)).toEqual([]);
    expect(reasoningLevelsForModel("claude", null, catalog)).toEqual([]);
    expect(reasoningLevelsForModel("claude", "opus", null)).toEqual([]);
    expect(reasoningLevelsForModel("devin", "claude-opus-5-5", catalog)).toEqual([]);
  });
});

describe("nearestReasoningLevel", () => {
  test("picks the closest supported level; a tie goes to the lower one", () => {
    expect(nearestReasoningLevel("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(nearestReasoningLevel("off", ["low", "high"])).toBe("low");
    expect(nearestReasoningLevel("medium", ["low", "high"])).toBe("low");
    expect(nearestReasoningLevel("max", ["low", "high", "xhigh"])).toBe("xhigh");
  });
  test("returns null when nothing is supported", () => {
    expect(nearestReasoningLevel("high", [])).toBeNull();
  });
});

describe("modelDisplayName", () => {
  test("drops the models.dev (latest) suffix only", () => {
    expect(modelDisplayName("Claude Haiku 4.5 (latest)")).toBe("Claude Haiku 4.5");
    expect(modelDisplayName("Claude Sonnet 4.5 (LATEST) ")).toBe("Claude Sonnet 4.5");
    expect(modelDisplayName("GPT-5.6 Sol")).toBe("GPT-5.6 Sol");
    expect(modelDisplayName("Llama (latest) Instruct")).toBe("Llama (latest) Instruct");
    expect(modelDisplayName("(latest)")).toBe("(latest)");
  });
  test("passes null and undefined through", () => {
    expect(modelDisplayName(undefined)).toBeUndefined();
    expect(modelDisplayName(null)).toBeUndefined();
  });
});
