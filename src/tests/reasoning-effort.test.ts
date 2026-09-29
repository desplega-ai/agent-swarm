/**
 * Phase 1 unit tests for the reasoning-effort helper module.
 *
 * Pure module tests — no DB, no network, no adapter wiring (that's Phase 4).
 * Model tuples below are picked from the real, checked-in
 * `src/providers/modelsdev-reasoning.json` snapshot so the cache-sourced vs.
 * fallback vs. override-table code paths are exercised against real data
 * rather than synthetic fixtures.
 */

import { describe, expect, test } from "bun:test";
import {
  applyReasoningEffort,
  REASONING_EFFORT_LEVELS,
  reasoningCapability,
} from "../providers/reasoning-effort";

describe("REASONING_EFFORT_LEVELS", () => {
  test("is the closed normalized enum", () => {
    expect(REASONING_EFFORT_LEVELS).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("reasoningCapability — cache-sourced levels", () => {
  test("Claude Opus 5.5 exposes supported CLI effort levels", () => {
    expect(reasoningCapability("claude", "claude-opus-5-5").levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
  test("Claude Sonnet 5.5 exposes supported CLI effort levels", () => {
    expect(reasoningCapability("claude", "claude-sonnet-5-5").levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
  test("claude claude-opus-4-8: levels come from reasoning_options.effort, not the fallback", () => {
    const cap = reasoningCapability("claude", "claude-opus-4-8");
    expect(cap.supported).toBe(true);
    // Cache lists [low, medium, high, xhigh, max]; "max" is not a Claude CLI effort.
    expect(cap.levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("codex gpt-5.6-sol supports the new max effort", () => {
    const cap = reasoningCapability("codex", "gpt-5.6-sol");
    expect(cap.supported).toBe(true);
    expect(cap.levels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  test("codex gpt-6-astra supports models.dev reasoning efforts", () => {
    const cap = reasoningCapability("codex", "gpt-6-astra");
    expect(cap.supported).toBe(true);
    expect(cap.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("codex gpt-5.1-codex-max: cache already includes xhigh", () => {
    const cap = reasoningCapability("codex", "gpt-5.1-codex-max");
    expect(cap.supported).toBe(true);
    expect(cap.levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("codex gpt-5.1-codex: cache already excludes xhigh (non-max)", () => {
    const cap = reasoningCapability("codex", "gpt-5.1-codex");
    expect(cap.supported).toBe(true);
    expect(cap.levels).toEqual(["low", "medium", "high"]);
    expect(cap.levels).not.toContain("xhigh");
  });

  test("pi openrouter/google/gemini-3-flash-preview: minimal dropped, off/xhigh absent from cache", () => {
    const cap = reasoningCapability("pi", "openrouter/google/gemini-3-flash-preview");
    expect(cap.supported).toBe(true);
    // Cache lists [minimal, low, medium, high]; "minimal" is dropped (out of scope).
    expect(cap.levels).toEqual(["low", "medium", "high"]);
  });
});

describe("reasoningCapability — fallback levels + override table", () => {
  test("claude claude-opus-4-0 (budget_tokens only, no effort entry): falls back to {low,medium,high}, override adds off", () => {
    const cap = reasoningCapability("claude", "claude-opus-4-0");
    expect(cap.supported).toBe(true);
    expect(cap.levels).toEqual(["off", "low", "medium", "high"]);
  });

  test("claude claude-opus-4-7 (adaptive-only, no budget_tokens): off is never added", () => {
    const cap = reasoningCapability("claude", "claude-opus-4-7");
    expect(cap.supported).toBe(true);
    expect(cap.levels).not.toContain("off");
    expect(cap.levels).toContain("xhigh");
  });
});

describe("reasoningCapability — boolean gate", () => {
  test("claude claude-3-opus-20240229 (reasoning: false) is unsupported", () => {
    const cap = reasoningCapability("claude", "claude-3-opus-20240229");
    expect(cap).toEqual({ supported: false, levels: [], default: null });
  });

  test("codex gpt-4o (reasoning: false) is unsupported", () => {
    const cap = reasoningCapability("codex", "gpt-4o");
    expect(cap).toEqual({ supported: false, levels: [], default: null });
  });

  test("pi + opencode openrouter/qwen/qwen3-coder-flash (reasoning: false) is unsupported for every harness, regardless of the override table", () => {
    for (const harness of ["pi", "opencode"] as const) {
      const cap = reasoningCapability(harness, "openrouter/qwen/qwen3-coder-flash");
      expect(cap).toEqual({ supported: false, levels: [], default: null });
    }
  });

  test("model with no capability data at all (custom/unknown string) is unsupported for every harness", () => {
    for (const harness of ["claude", "codex", "pi", "opencode"] as const) {
      const cap = reasoningCapability(harness, "totally-custom-model-xyz");
      expect(cap).toEqual({ supported: false, levels: [], default: null });
    }
  });
});

describe("applyReasoningEffort — noop cases", () => {
  test("undefined level is always noop", () => {
    expect(applyReasoningEffort("claude", "claude-opus-4-8", undefined)).toEqual({ kind: "noop" });
  });

  test("no capability data (custom model) is noop", () => {
    expect(applyReasoningEffort("codex", "totally-custom-model-xyz", "high")).toEqual({
      kind: "noop",
    });
  });

  test("codex xhigh on gpt-5.1-codex (non-max) is noop — capability excludes xhigh from levels", () => {
    const cap = reasoningCapability("codex", "gpt-5.1-codex");
    expect(cap.levels).not.toContain("xhigh");
    expect(applyReasoningEffort("codex", "gpt-5.1-codex", "xhigh")).toEqual({ kind: "noop" });
  });

  test("claude off on claude-opus-4-7 is noop — adaptive-only model has no off semantics", () => {
    expect(applyReasoningEffort("claude", "claude-opus-4-7", "off")).toEqual({ kind: "noop" });
  });
});

describe("applyReasoningEffort — claude-env shape", () => {
  test("high sets CLAUDE_CODE_EFFORT_LEVEL", () => {
    expect(applyReasoningEffort("claude", "claude-opus-4-8", "high")).toEqual({
      kind: "claude-env",
      env: { CLAUDE_CODE_EFFORT_LEVEL: "high" },
    });
  });

  test("off on a legacy (budget_tokens-capable) model sets MAX_THINKING_TOKENS=0 and omits the effort env", () => {
    const result = applyReasoningEffort("claude", "claude-opus-4-0", "off");
    expect(result).toEqual({ kind: "claude-env", env: { MAX_THINKING_TOKENS: "0" } });
    if (result.kind === "claude-env") {
      expect(result.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    }
  });
});

describe("applyReasoningEffort — codex-config shape", () => {
  test("high sets model_reasoning_effort", () => {
    expect(applyReasoningEffort("codex", "gpt-5.1-codex", "high")).toEqual({
      kind: "codex-config",
      config: { model_reasoning_effort: "high" },
    });
  });

  test("off maps to model_reasoning_effort: 'none'", () => {
    // gpt-5.1-codex-max's cache entry has no "none" in its effort values, so
    // `off` isn't in its capability levels — use gpt-5.3-codex, which does
    // advertise "none" (mapped to our normalized "off").
    const cap = reasoningCapability("codex", "gpt-5.3-codex");
    expect(cap.levels).toContain("off");
    expect(applyReasoningEffort("codex", "gpt-5.3-codex", "off")).toEqual({
      kind: "codex-config",
      config: { model_reasoning_effort: "none" },
    });
  });

  test("xhigh on gpt-5.1-codex-max (max variant) is applied", () => {
    expect(applyReasoningEffort("codex", "gpt-5.1-codex-max", "xhigh")).toEqual({
      kind: "codex-config",
      config: { model_reasoning_effort: "xhigh" },
    });
  });

  test("max on gpt-5.6-sol is applied", () => {
    expect(applyReasoningEffort("codex", "gpt-5.6-sol", "max")).toEqual({
      kind: "codex-config",
      config: { model_reasoning_effort: "max" },
    });
  });

  test("max on gpt-6-astra is applied", () => {
    expect(applyReasoningEffort("codex", "gpt-6-astra", "max")).toEqual({
      kind: "codex-config",
      config: { model_reasoning_effort: "max" },
    });
  });
});

describe("applyReasoningEffort — pi-session shape", () => {
  test("medium sets thinkingLevel", () => {
    expect(
      applyReasoningEffort("pi", "openrouter/google/gemini-3-flash-preview", "medium"),
    ).toEqual({
      kind: "pi-session",
      sessionOptions: { thinkingLevel: "medium" },
    });
  });
});

describe("applyReasoningEffort — opencode-options shape", () => {
  test("openrouter-routed model uses the reasoning.effort key", () => {
    expect(
      applyReasoningEffort("opencode", "openrouter/google/gemini-3-flash-preview", "low"),
    ).toEqual({
      kind: "opencode-options",
      providerId: "openrouter",
      modelId: "google/gemini-3-flash-preview",
      options: { reasoning: { effort: "low" } },
    });
  });

  test("anthropic-routed model uses the thinking.budgetTokens key (internal transport detail, not a numeric user knob)", () => {
    expect(applyReasoningEffort("opencode", "anthropic/claude-opus-4-8", "high")).toEqual({
      kind: "opencode-options",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      options: { thinking: { type: "enabled", budgetTokens: 32768 } },
    });
  });

  test("off omits reasoning keys entirely (noop), even when the model's cache entry advertises off", () => {
    // openai/gpt-5.3-codex advertises "none" in its effort values, so `off` is
    // a valid capability level here — Opencode still has no off switch, so
    // applying it is a noop by design (see helper's per-harness mapping doc).
    const cap = reasoningCapability("opencode", "openai/gpt-5.3-codex");
    expect(cap.levels).toContain("off");
    expect(applyReasoningEffort("opencode", "openai/gpt-5.3-codex", "off")).toEqual({
      kind: "noop",
    });
  });
});

// The offered levels, the API's validation and the harness application all read the same
// answer. This matrix pins it per (harness, model) so the swarm app's pickers, the runtime
// PATCH and the run-time adapters cannot drift apart.
describe("harness × model → effort matrix", () => {
  const matrix: {
    harness: "claude" | "codex" | "pi" | "opencode";
    model: string;
    levels: string[];
  }[] = [
    { harness: "claude", model: "claude-opus-5-5", levels: ["low", "medium", "high", "xhigh"] },
    { harness: "claude", model: "claude-sonnet-5-5", levels: ["low", "medium", "high", "xhigh"] },
    { harness: "claude", model: "claude-haiku-4-5", levels: ["off", "low", "medium", "high"] },
    {
      harness: "codex",
      model: "gpt-5.6-sol",
      levels: ["off", "low", "medium", "high", "xhigh", "max"],
    },
    { harness: "codex", model: "gpt-6-astra", levels: ["low", "medium", "high", "xhigh", "max"] },
    { harness: "codex", model: "gpt-5.1-codex", levels: ["low", "medium", "high"] },
    { harness: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash", levels: ["low", "high"] },
    {
      harness: "pi",
      model: "openrouter/anthropic/claude-opus-5.5",
      levels: ["low", "medium", "high", "xhigh"],
    },
    {
      harness: "opencode",
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      levels: ["low", "high"],
    },
    { harness: "pi", model: "openrouter/qwen/qwen3-coder-flash", levels: [] },
    { harness: "claude", model: "totally-custom-model-xyz", levels: [] },
  ];

  for (const { harness, model, levels } of matrix) {
    test(`${harness} ${model}: ${levels.length > 0 ? levels.join(", ") : "no effort"}`, () => {
      expect(reasoningCapability(harness, model).levels).toEqual(levels);
      // Every offered level is applied, every other level is dropped: what a picker offers is what
      // reaches the harness.
      for (const level of REASONING_EFFORT_LEVELS) {
        const applied = applyReasoningEffort(harness, model, level);
        const takes = levels.includes(level);
        // opencode has no explicit off, so its `off` is a noop even when offered.
        const expectNoop = !takes || (harness === "opencode" && level === "off");
        expect(applied.kind === "noop").toBe(expectNoop);
      }
    });
  }
});

describe("Claude CLI shortnames (the tier defaults) take effort like the model they stand for", () => {
  test("opus, sonnet, haiku and fable resolve to their newest catalog model", () => {
    expect(reasoningCapability("claude", "opus")).toEqual(
      reasoningCapability("claude", "claude-opus-5-5"),
    );
    expect(reasoningCapability("claude", "sonnet")).toEqual(
      reasoningCapability("claude", "claude-sonnet-5-5"),
    );
    expect(reasoningCapability("claude", "haiku").levels).toContain("off");
    expect(reasoningCapability("claude", "fable").supported).toBe(true);
  });

  test("a stored effort reaches the CLI when the resolved model is a shortname", () => {
    expect(applyReasoningEffort("claude", "opus", "high")).toEqual({
      kind: "claude-env",
      env: { CLAUDE_CODE_EFFORT_LEVEL: "high" },
    });
    expect(applyReasoningEffort("claude", "opus", "max")).toEqual({ kind: "noop" });
  });

  test("shortnames mean nothing to the other harnesses", () => {
    expect(reasoningCapability("codex", "opus").supported).toBe(false);
    expect(reasoningCapability("pi", "opus").supported).toBe(false);
  });
});
