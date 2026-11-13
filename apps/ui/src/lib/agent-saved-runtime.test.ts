import { describe, expect, test } from "bun:test";
import type { ModelProfile, SwarmConfig } from "../api/types";
import { savedRuntimeByAgent } from "./agent-saved-runtime";
import { getAgentModelDisplay } from "./agents-list-model-display";

const lead = { id: "lead", harnessProvider: "claude" as const };

const row = (key: string, value: string, scopeId = "lead", scope = "agent"): SwarmConfig =>
  ({ scope, scopeId, key, value }) as SwarmConfig;

const profile = (over: Partial<ModelProfile>): ModelProfile =>
  ({
    name: "claude-opus-5-5-high",
    harness: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    ...over,
  }) as ModelProfile;

const saved = (
  configs: SwarmConfig[],
  profiles: ModelProfile[] | undefined = [profile({})],
  agent = lead,
) => savedRuntimeByAgent(configs, [agent], profiles).get(agent.id);

describe("savedRuntimeByAgent", () => {
  test("the default profile beats MODEL_OVERRIDE, as claim does", () => {
    const configs = [
      row("MODEL_OVERRIDE", "claude-fable-5-2"),
      row("MODEL_PROFILE", "claude-opus-5-5-high"),
    ];
    expect(saved(configs)).toEqual({ model: "claude-opus-5-5", effort: "high" });
    // The agents list: Lead last ran Opus 5.5, so nothing is pending.
    const display = getAgentModelDisplay(saved(configs)?.model, "claude-opus-5-5");
    expect(display.primary).toBe("claude-opus-5-5");
    expect(display.diverged).toBe(false);
  });

  test("MODEL_OVERRIDE alone is the saved model", () => {
    expect(saved([row("MODEL_OVERRIDE", "claude-fable-5-2")])).toEqual({
      model: "claude-fable-5-2",
      effort: undefined,
    });
  });

  test("a profile that does not apply leaves MODEL_OVERRIDE in charge", () => {
    const configs = [row("MODEL_OVERRIDE", "sonnet"), row("MODEL_PROFILE", "claude-opus-5-5-high")];
    // Missing, and on another harness: claim skips both.
    expect(saved(configs, [])?.model).toBe("sonnet");
    expect(saved(configs, [profile({ harness: "codex" })])?.model).toBe("sonnet");
  });

  test("profiles still loading show no model instead of one that may lose", () => {
    const configs = [row("MODEL_OVERRIDE", "sonnet"), row("MODEL_PROFILE", "claude-opus-5-5-high")];
    expect(savedRuntimeByAgent(configs, [lead], undefined).get("lead")).toEqual({});
  });

  test("a profile without effort keeps the effort override; a latest: alias names no model", () => {
    const configs = [
      row("REASONING_EFFORT_OVERRIDE", "low"),
      row("MODEL_OVERRIDE", "sonnet"),
      row("MODEL_PROFILE", "claude-opus-5-5-high"),
    ];
    expect(saved(configs, [profile({ effort: null })])).toEqual({
      model: "claude-opus-5-5",
      effort: "low",
    });
    expect(saved(configs, [profile({ model: "latest:anthropic/opus", effort: null })])).toEqual({
      model: undefined,
      effort: "low",
    });
  });

  test("rows of other scopes and agents do not count", () => {
    const configs = [
      row("MODEL_OVERRIDE", "haiku", "lead", "repo"),
      row("MODEL_OVERRIDE", "sonnet", "other"),
    ];
    expect(saved(configs)).toBeUndefined();
  });
});
