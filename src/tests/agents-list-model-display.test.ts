import { describe, expect, test } from "bun:test";
import type { LiveModelsCatalog } from "../../apps/ui/src/lib/agent-runtime-models";
import {
  getAgentModelDisplay,
  getAgentModelPresentation,
} from "../../apps/ui/src/lib/agents-list-model-display";

const liveCatalog: LiveModelsCatalog = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "deepseek/deepseek-v4-pro": { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      "deepseek/deepseek-v4.1-flash": {
        id: "deepseek/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
      },
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    models: {
      "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    },
  },
};

describe("agents list model display", () => {
  test("shows configured and last-used models when they diverge", () => {
    const display = getAgentModelDisplay("claude-opus-4-7", "claude-sonnet-4-6");

    expect(display).toEqual({
      configured: "claude-opus-4-7",
      lastUsed: "claude-sonnet-4-6",
      primary: "claude-opus-4-7",
      diverged: true,
    });
  });

  test("shows one model when configured and last-used match", () => {
    const display = getAgentModelDisplay("claude-sonnet-4-6", "claude-sonnet-4-6");

    expect(display).toEqual({
      configured: "claude-sonnet-4-6",
      lastUsed: "claude-sonnet-4-6",
      primary: "claude-sonnet-4-6",
      diverged: false,
    });
  });

  test("shows configured model alone before an agent reports a last-used model", () => {
    const display = getAgentModelDisplay("claude-opus-4-7", null);

    expect(display.primary).toBe("claude-opus-4-7");
    expect(display.diverged).toBe(false);
  });

  test("presents known provider-prefixed model ids as readable labels", () => {
    expect(getAgentModelPresentation("openrouter/deepseek/deepseek-v4-flash")).toEqual({
      raw: "openrouter/deepseek/deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      provider: "OpenRouter",
      providerId: "openrouter",
    });
  });

  test.each([
    ["openrouter/deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", "OpenRouter"],
    ["openrouter/deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "OpenRouter"],
    ["opencode/glm-5.3-flash", "GLM-5.3-Flash", "OpenCode Zen"],
    ["claude-opus-5-5", "Claude Opus 5.5", "Anthropic"],
  ])("resolves %s from the live catalog", (model, label, provider) => {
    expect(getAgentModelPresentation(model, liveCatalog)).toMatchObject({
      raw: model,
      label,
      provider,
    });
  });

  test("title-cases an uncatalogued model id without a maintained label entry", () => {
    expect(
      getAgentModelPresentation("opencode/future-model-v8.2-preview", liveCatalog),
    ).toMatchObject({
      label: "Future Model V8.2 Preview",
      provider: null,
    });
    expect(
      getAgentModelPresentation("openrouter/deepseek/deepseek-v5.1-flash", liveCatalog)?.label,
    ).toBe("Deepseek V5.1 Flash");
  });

  test("presents latest Anthropic direct model ids as readable labels", () => {
    expect(getAgentModelPresentation("claude-fable-5-1")).toMatchObject({
      label: "Claude Fable 5.1",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("claude-mythos-5-1")).toMatchObject({
      label: "Claude Mythos 5.1",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("claude-opus-5-5")).toMatchObject({
      label: "Claude Opus 5.5",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("claude-opus-5")).toMatchObject({
      label: "Claude Opus 5",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("claude-fable-5")).toMatchObject({
      label: "Claude Fable 5",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("claude-mythos-5")).toMatchObject({
      label: "Claude Mythos 5",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("sonnet")).toMatchObject({
      label: "Claude Sonnet 5",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("opus")).toMatchObject({
      label: "Claude Opus 5.5",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("fable")).toMatchObject({
      label: "Claude Fable 5.1",
      provider: "Anthropic",
      providerId: "anthropic",
    });
    expect(getAgentModelPresentation("mythos")).toMatchObject({
      label: "Claude Mythos 5.1",
      provider: "Anthropic",
      providerId: "anthropic",
    });
  });

  test.each([
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
  ])("presents Codex model %s as a readable label", (model, label) => {
    expect(getAgentModelPresentation(model)).toMatchObject({
      raw: model,
      label,
      provider: "OpenAI",
      providerId: "openai",
    });
  });

  // ── Phase 6 (reasoning-effort plan) ─────────────────────────────────────────

  test("getAgentModelDisplay threads reasoningEffort through unchanged", () => {
    const display = getAgentModelDisplay("claude-opus-4-8", "claude-opus-4-8", "high");
    expect(display.reasoningEffort).toBe("high");
  });
});
