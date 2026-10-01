import { describe, expect, test } from "bun:test";
import {
  effortAfterChange,
  effortLevelsFor,
  findKnownModel,
  type LiveModelsCatalog,
  modelGroupsForHarness,
  modelGroupsForSchedule,
} from "./agent-runtime-models";

/** A live catalog holding only the given sections. */
function live(sections: Record<string, Record<string, object>>): LiveModelsCatalog {
  return Object.fromEntries(
    Object.entries(sections).map(([id, models]) => [
      id,
      {
        id,
        models: Object.fromEntries(
          Object.entries(models).map(([modelId, model]) => [modelId, { id: modelId, ...model }]),
        ),
      },
    ]),
  ) as unknown as LiveModelsCatalog;
}

const effort = (values: string[]) => [{ type: "effort", values }];

describe("effortLevelsFor: what a harness and model accept", () => {
  test("Claude: an adaptive model has no off; a budget-token model gains it", () => {
    // Opus 5.5 lists effort levels; `max` is codex-only, so it is dropped.
    expect(effortLevelsFor("claude", "claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Haiku 4.5 has a thinking budget and no effort levels: off plus the shared subset.
    expect(effortLevelsFor("claude", "claude-haiku-4-5")).toEqual(["off", "low", "medium", "high"]);
  });

  test("Claude CLI shortnames resolve to the newest model of their family", () => {
    expect(effortLevelsFor("claude", "opus")).toEqual(effortLevelsFor("claude", "claude-opus-5-5"));
    expect(effortLevelsFor("claude", "haiku")).toEqual(["off", "low", "medium", "high"]);
    expect(effortLevelsFor("claude", "sonnet").length).toBeGreaterThan(0);
    // The live catalog decides which model a shortname means (a model with no
    // release date is just launched, so it ranks newest: the id breaks the tie).
    const catalog = live({
      anthropic: {
        "claude-opus-9-9": {
          reasoning: true,
          reasoning_options: effort(["low", "high"]),
        },
      },
    });
    expect(effortLevelsFor("claude", "opus", catalog)).toEqual(["low", "high"]);
  });

  test("Codex: a GPT-5.6 model takes max", () => {
    expect(effortLevelsFor("codex", "gpt-5.6-sol")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("Pi and Opencode read <provider>/<id>, the id may hold more slashes", () => {
    const openrouter = "openrouter/deepseek/deepseek-v4.1-flash";
    expect(effortLevelsFor("pi", openrouter)).toEqual(["low", "high"]);
    expect(effortLevelsFor("opencode", openrouter)).toEqual(["low", "high"]);
    // `max` is codex-only whichever provider the model comes from.
    expect(effortLevelsFor("pi", "openrouter/anthropic/claude-opus-5.5")).not.toContain("max");
    // A bare id names no provider: unknown.
    expect(effortLevelsFor("pi", "deepseek-v4-flash")).toEqual([]);
  });

  test("a custom or unlisted model takes no effort: the API rejects one", () => {
    expect(effortLevelsFor("claude", "my-custom-model")).toEqual([]);
    expect(effortLevelsFor("codex", "gpt-nope")).toEqual([]);
    expect(effortLevelsFor("pi", "openrouter/nope/nothing")).toEqual([]);
    expect(effortLevelsFor("pi", "nosuchprovider/x")).toEqual([]);
    expect(effortLevelsFor("claude", "")).toEqual([]);
    expect(effortLevelsFor("claude", null)).toEqual([]);
    // A prototype member is not a provider.
    expect(effortLevelsFor("pi", "constructor/toString")).toEqual([]);
  });

  test("a harness without effort control takes none, whatever the model", () => {
    for (const harness of ["acp", "devin", "claude-managed", "nope"]) {
      expect(effortLevelsFor(harness, "claude-opus-5-5")).toEqual([]);
      expect(effortLevelsFor(harness, "openrouter/deepseek/deepseek-v4.1-flash")).toEqual([]);
    }
  });

  test("dsh reads OpenRouter ids and bare DeepSeek ids from their own sections", () => {
    expect(effortLevelsFor("dsh", "openrouter/deepseek/deepseek-v4.1-flash")).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(effortLevelsFor("dsh", "deepseek-v4-pro")).toEqual(["off", "high", "max"]);
    // dsh's own id for V4.1 Flash is not in the catalog: no level is claimed for it.
    expect(effortLevelsFor("dsh", "deepseek-flash")).toEqual([]);
  });

  test("a model that does not reason takes none", () => {
    const catalog = live({ anthropic: { "claude-plain-1": { reasoning: false } } });
    expect(effortLevelsFor("claude", "claude-plain-1", catalog)).toEqual([]);
  });

  test("the live catalog wins per model id, the snapshot fills the rest", () => {
    const catalog = live({
      openai: { "gpt-5.6-sol": { reasoning: true, reasoning_options: effort(["low", "medium"]) } },
    });
    expect(effortLevelsFor("codex", "gpt-5.6-sol", catalog)).toEqual(["low", "medium"]);
    // Not in the live section: the bundled snapshot still knows it.
    expect(effortLevelsFor("codex", "gpt-5.6-luna", catalog)).toContain("max");
  });

  test("ModelOption.reasoningLevels agrees with effortLevelsFor", () => {
    for (const harness of ["claude", "codex", "pi"] as const) {
      const models = modelGroupsForHarness(harness, undefined, undefined).flatMap((g) => g.models);
      for (const model of models.slice(0, 40)) {
        expect(model.reasoningLevels).toEqual(effortLevelsFor(harness, model.id));
      }
    }
  });
});

describe("effortAfterChange: switching harness or model", () => {
  test("keeps an effort the new pair takes, resets one it cannot to Auto", () => {
    expect(effortAfterChange("xhigh", "claude", "claude-opus-5-5")).toBe("xhigh");
    // Haiku 4.5 has no xhigh.
    expect(effortAfterChange("xhigh", "claude", "claude-haiku-4-5")).toBe("");
    // Codex takes max, Claude does not.
    expect(effortAfterChange("max", "codex", "gpt-5.6-sol")).toBe("max");
    expect(effortAfterChange("max", "claude", "claude-opus-5-5")).toBe("");
    // Off is a Haiku level, not an Opus 5.5 one.
    expect(effortAfterChange("off", "claude", "claude-haiku-4-5")).toBe("off");
    expect(effortAfterChange("off", "claude", "opus")).toBe("");
  });

  test("resets on a custom model, an unknown one, and a harness with no control", () => {
    expect(effortAfterChange("high", "claude", "my-custom-model")).toBe("");
    expect(effortAfterChange("high", "claude", "")).toBe("");
    expect(effortAfterChange("high", "acp", "claude-opus-5-5")).toBe("");
  });

  test("Auto stays Auto", () => {
    expect(effortAfterChange("", "claude", "claude-opus-5-5")).toBe("");
  });
});

describe('model labels drop models.dev\'s "(latest)" suffix', () => {
  const catalog = live({
    anthropic: {
      "claude-haiku-9": {
        name: "Claude Haiku 9 (latest)",
        release_date: "2030-01-01",
        reasoning: true,
      },
    },
    openrouter: { "acme/thing": { name: "Acme Thing (latest)" } },
    openai: { "gpt-9": { name: "GPT-9 (latest)", release_date: "2030-01-01" } },
  });

  test("the harness picker options", () => {
    const [claude] = modelGroupsForHarness("claude", undefined, undefined, null, catalog);
    expect(claude.models[0].label).toBe("Claude Haiku 9");
    const [codex] = modelGroupsForHarness("codex", undefined, undefined, null, catalog);
    expect(codex.models[0].label).toBe("GPT-9");
    const openrouter = modelGroupsForHarness("pi", undefined, undefined, null, catalog).find(
      (g) => g.provider === "OpenRouter",
    );
    expect(openrouter?.models.map((m) => m.label)).toEqual(["Acme Thing"]);
  });

  test("the bundled snapshot names Claude Haiku 4.5 without the suffix", () => {
    const [claude] = modelGroupsForHarness("claude", undefined, undefined);
    expect(claude.models.find((m) => m.id === "claude-haiku-4-5")?.label).toBe("Claude Haiku 4.5");
    expect(findKnownModel("claude-haiku-4-5")?.label).toBe("Claude Haiku 4.5");
  });

  test("read-only lookups, the schedule aliases, and a reported label", () => {
    expect(findKnownModel("claude-haiku-9", catalog)?.label).toBe("Claude Haiku 9");
    expect(findKnownModel("openrouter/acme/thing", catalog)?.label).toBe("Acme Thing");
    const [aliases] = modelGroupsForSchedule(catalog);
    expect(aliases.models.find((m) => m.id === "haiku")?.label).toBe("Haiku (Claude Haiku 9)");
    // A harness that reports the clean name still finds the model.
    expect(findKnownModel("Acme Thing", catalog)?.id).toBe("openrouter/acme/thing");
  });

  test("a name without the suffix is untouched", () => {
    const plain = live({ anthropic: { "claude-plain-1": { name: "Claude Plain (beta)" } } });
    expect(findKnownModel("claude-plain-1", plain)?.label).toBe("Claude Plain (beta)");
  });
});
