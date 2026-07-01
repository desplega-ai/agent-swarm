import { describe, expect, test } from "bun:test";
import {
  getAgentModelDisplay,
  getAgentModelPresentation,
} from "../../ui/src/lib/agents-list-model-display";

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

  test("presents latest Anthropic direct model ids as readable labels", () => {
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
  });

  // ── Phase 6 (reasoning-effort plan) ─────────────────────────────────────────

  test("getAgentModelDisplay threads reasoningEffort through unchanged", () => {
    const display = getAgentModelDisplay("claude-opus-4-8", "claude-opus-4-8", "high");
    expect(display.reasoningEffort).toBe("high");
  });
});
