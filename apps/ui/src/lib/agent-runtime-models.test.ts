import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import {
  effortAfterChange,
  effortLevelsFor,
  findKnownModel,
  type LiveModelsCatalog,
  modelGroupsForHarness,
  modelGroupsForSchedule,
} from "./agent-runtime-models";
import { getAgentModelPresentation } from "./agents-list-model-display";
import { modelVendor } from "./model-vendor";

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
    // Opus 5.5 lists effort levels; claude does not pass `max` through, so it drops it.
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
    expect(effortLevelsFor("claude", "haiku")).toEqual(
      effortLevelsFor("claude", "claude-haiku-5-5"),
    );
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
    // pi and opencode pass the model's own effort values through (`none` is off).
    expect(effortLevelsFor("pi", openrouter)).toEqual(["off", "low", "high", "max"]);
    expect(effortLevelsFor("opencode", openrouter)).toEqual(["off", "low", "high", "max"]);
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
    expect(effortLevelsFor("dsh", "deepseek-v4-pro")).toEqual(["off", "low", "high", "max"]);
    // dsh's own id for V4.1 Flash reads its `deepseek` section row.
    expect(effortLevelsFor("dsh", "deepseek-flash")).toEqual(["off", "low", "high", "max"]);
  });

  test("amp: a mode names no model, so only a pinned provider/model takes effort", () => {
    for (const mode of ["low", "medium", "high", "ultra"]) {
      expect(effortLevelsFor("amp", mode)).toEqual([]);
    }
    // Same catalog rule as pi and opencode: a provider/model pin, `max` dropped.
    expect(effortLevelsFor("amp", "anthropic/claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effortLevelsFor("amp", "openai/gpt-5-nano")).toEqual(
      effortLevelsFor("pi", "openai/gpt-5-nano"),
    );
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

describe("modelGroupsForHarness: amp", () => {
  const keyed = [{ key: "AMP_API_KEY", value: "set" }] as never;

  test("offers the four modes first, then pinnable Anthropic and OpenAI models", () => {
    const groups = modelGroupsForHarness("amp", keyed, undefined);
    expect(groups.map((g) => g.provider)).toEqual([
      "Amp modes",
      "Anthropic (pinned)",
      "OpenAI (pinned)",
    ]);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(["low", "medium", "high", "ultra"]);
    expect(groups[0]?.models[0]?.label).toBe("Low (cheapest)");
    expect(groups.every((g) => g.requiredKey === "AMP_API_KEY")).toBe(true);
    const pins = groups.slice(1).flatMap((g) => g.models.map((m) => m.id));
    expect(pins.length).toBeGreaterThan(10);
    expect(pins.every((id) => /^(anthropic|openai)\//.test(id))).toBe(true);
  });

  test("every group is disabled until AMP_API_KEY is configured", () => {
    expect(modelGroupsForHarness("amp", [], undefined).some((g) => g.enabled)).toBe(false);
    expect(modelGroupsForHarness("amp", keyed, undefined).every((g) => g.enabled)).toBe(true);
    expect(modelGroupsForHarness("amp", [], { AMP_API_KEY: true }).every((g) => g.enabled)).toBe(
      true,
    );
  });

  test("a pinned model lists the effort levels the API would accept", () => {
    const groups = modelGroupsForHarness("amp", keyed, undefined);
    const opus = groups.flatMap((g) => g.models).find((m) => m.id === "anthropic/claude-opus-5-5");
    expect(opus?.reasoningLevels).toEqual(effortLevelsFor("amp", "anthropic/claude-opus-5-5"));
    expect(groups[0]?.models.every((m) => m.reasoningLevels?.length === 0)).toBe(true);
  });

  test("a mode carries Amp's mark everywhere a model is shown", () => {
    const groups = modelGroupsForHarness("amp", keyed, undefined);
    expect(groups[0]?.models.every((m) => m.providerId === "amp")).toBe(true);
    expect(getAgentModelPresentation("medium")).toMatchObject({
      label: "Medium",
      provider: "Amp modes",
      providerId: "amp",
    });
    expect(modelVendor("ultra")).toBe("amp");
    // A pin keeps its maker's mark, and a word that only contains a mode name is not a mode.
    expect(getAgentModelPresentation("anthropic/claude-opus-5-5")?.providerId).toBe("anthropic");
    expect(modelVendor("anthropic/claude-opus-5-5")).toBe("anthropic");
    expect(modelVendor("gemini-high")).toBe("google");
    expect(modelVendor("highway")).toBeNull();
  });
});

describe("cursor harness models", () => {
  const catalog = live({
    openai: {
      "gpt-5.4-nano": {
        name: "GPT-5.4 nano",
        reasoning: true,
        reasoning_options: effort(["none", "low", "high"]),
      },
    },
    anthropic: {
      "claude-opus-5-5": {
        name: "Claude Opus 5.5",
        reasoning: true,
        reasoning_options: effort(["low", "max"]),
      },
    },
  });

  test("one Cursor group behind CURSOR_API_KEY, labelled from the vendor catalog", () => {
    const [group, ...rest] = modelGroupsForHarness(
      "cursor",
      [],
      { CURSOR_API_KEY: true },
      null,
      catalog,
    );
    expect(rest).toEqual([]);
    expect(group?.provider).toBe("Cursor");
    expect(group?.requiredKey).toBe("CURSOR_API_KEY");
    expect(group?.enabled).toBe(true);
    const nano = group?.models.find((m) => m.id === "gpt-5.4-nano");
    expect(nano?.label).toBe("GPT-5.4 nano");
    expect(nano?.reasoningLevels).toEqual(["off", "low", "high"]);
    // Cursor-only models have no catalog row and take no effort.
    expect(group?.models.find((m) => m.id === "composer-2.5")?.reasoningLevels).toEqual([]);
    expect(modelGroupsForHarness("cursor", [], {}, null, catalog)[0]?.enabled).toBe(false);
  });

  test("effort reads the vendor section; cursor keeps max", () => {
    expect(effortLevelsFor("cursor", "claude-opus-5-5", catalog)).toEqual(["low", "max"]);
    expect(effortLevelsFor("cursor", "composer-2.5", catalog)).toEqual([]);
  });
});

describe("grok harness models", () => {
  const catalog = live({
    xai: {
      "grok-4.6": {
        name: "Grok 4.6",
        reasoning: true,
        reasoning_options: effort(["low", "medium", "high", "xhigh"]),
      },
    },
    openrouter: {
      "acme/thing": {
        name: "Acme Thing",
        reasoning: true,
        reasoning_options: effort(["low", "high"]),
      },
    },
  });

  test("an xAI group behind XAI_API_KEY with the CLI's models", () => {
    const [group] = modelGroupsForHarness("grok", [], { XAI_API_KEY: true }, null, catalog);
    expect(group?.provider).toBe("xAI");
    expect(group?.requiredKey).toBe("XAI_API_KEY");
    expect(group?.enabled).toBe(true);
    expect(group?.models.map((m) => m.id)).toEqual([
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-build-0.1",
    ]);
    const grok46 = group?.models.find((m) => m.id === "grok-4.6");
    expect(grok46?.label).toBe("Grok 4.6");
    expect(grok46?.reasoningLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(modelGroupsForHarness("grok", [], {}, null, catalog)[0]?.enabled).toBe(false);
  });

  test("an OpenRouter group behind OPENROUTER_API_KEY with openrouter/ ids", () => {
    const groups = modelGroupsForHarness("grok", [], { OPENROUTER_API_KEY: true }, null, catalog);
    expect(groups.map((g) => [g.requiredKey, g.enabled])).toEqual([
      ["XAI_API_KEY", false],
      ["OPENROUTER_API_KEY", true],
    ]);
    expect(groups[1]?.models.map((m) => [m.id, m.reasoningLevels])).toEqual([
      ["openrouter/acme/thing", ["low", "high"]],
    ]);
    expect(effortLevelsFor("grok", "openrouter/acme/thing", catalog)).toEqual(["low", "high"]);
  });

  test("effort reads the xai section", () => {
    expect(effortLevelsFor("grok", "grok-4.6", catalog)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effortLevelsFor("grok", "grok-unknown", catalog)).toEqual([]);
  });
});

describe("Vercel AI Gateway on the open harnesses", () => {
  for (const harness of ["pi", "opencode"] as const) {
    test(`${harness}: the snapshot group lists every chat model and no embedding model`, () => {
      const groups = modelGroupsForHarness(harness, [], { AI_GATEWAY_API_KEY: true });
      const vercel = groups.find((g) => g.provider === "Vercel AI Gateway");
      expect(vercel).toMatchObject({ requiredKey: "AI_GATEWAY_API_KEY", enabled: true });
      const ids = vercel?.models.map((m) => m.id) ?? [];
      expect(ids.length).toBeGreaterThan(200);
      expect(ids).toContain("vercel/zai/glm-5.3");
      expect(ids).toContain("vercel/anthropic/claude-sonnet-4.6");
      expect(ids).not.toContain("vercel/voyage/voyage-code-3");
      expect(vercel?.models.every((m) => m.providerId === "vercel")).toBe(true);
    });
  }
});

describe("NaN and Helmcode on the open harnesses", () => {
  const catalog = live({
    nan: { "glm5.3-flash": { name: "GLM 5.3 Flash" }, "qwen3.6": { name: "Qwen 3.6" } },
    helmcode: { gemma4: { name: "Gemma 4" }, "deepseek-v4-flash": { name: "DeepSeek V4 Flash" } },
  });
  const group = (groups: ReturnType<typeof modelGroupsForHarness>, provider: string) =>
    groups.find((g) => g.provider === provider);

  for (const harness of ["pi", "opencode"] as const) {
    test(`${harness}: both groups list their routes and are locked without a key`, () => {
      const groups = modelGroupsForHarness(harness, [], {}, null, catalog);
      const nan = group(groups, "NaN");
      const helmcode = group(groups, "Helmcode");
      expect(nan).toMatchObject({ requiredKey: "NAN_API_KEY", enabled: false });
      expect(helmcode).toMatchObject({ requiredKey: "HELMCODE_API_KEY", enabled: false });
      expect(nan?.models.map((m) => [m.id, m.providerId])).toEqual([
        ["nan/glm5.3-flash", "nan"],
        ["nan/qwen3.6", "nan"],
      ]);
      expect(helmcode?.models.map((m) => [m.id, m.providerId])).toEqual([
        ["helmcode/deepseek-v4-flash", "helmcode"],
        ["helmcode/gemma4", "helmcode"],
      ]);
      // Listed right after OpenRouter.
      expect(groups.slice(0, 3).map((g) => g.provider)).toEqual(["OpenRouter", "NaN", "Helmcode"]);
    });
  }

  test("the HELMCODE_API_NAN alias unlocks NaN only", () => {
    const groups = modelGroupsForHarness("pi", [], { HELMCODE_API_NAN: true }, null, catalog);
    expect(group(groups, "NaN")?.enabled).toBe(true);
    expect(group(groups, "Helmcode")?.enabled).toBe(false);
  });

  test("a stored alias config row unlocks NaN too", () => {
    const row = { key: "HELMCODE_API_NAN", value: "********" } as SwarmConfig;
    const groups = modelGroupsForHarness("opencode", [row], {}, null, catalog);
    expect(group(groups, "NaN")?.enabled).toBe(true);
  });

  test("HELMCODE_API_KEY unlocks Helmcode only", () => {
    const groups = modelGroupsForHarness("pi", [], { HELMCODE_API_KEY: true }, null, catalog);
    expect(group(groups, "Helmcode")?.enabled).toBe(true);
    expect(group(groups, "NaN")?.enabled).toBe(false);
  });

  test("NAN_API_KEY unlocks NaN, and neither key unlocks OpenRouter", () => {
    const groups = modelGroupsForHarness("pi", [], { NAN_API_KEY: true }, null, catalog);
    expect(group(groups, "NaN")?.enabled).toBe(true);
    expect(group(groups, "OpenRouter")?.enabled).toBe(false);
  });

  test("the claude and codex pickers never list them", () => {
    for (const harness of ["claude", "codex"] as const) {
      const groups = modelGroupsForHarness(harness, [], { NAN_API_KEY: true }, null, catalog);
      expect(groups.flatMap((g) => g.models).some((m) => /^(nan|helmcode)\//.test(m.id))).toBe(
        false,
      );
    }
  });

  test("a reported route resolves to its provider glyph", () => {
    expect(findKnownModel("nan/glm5.3-flash", catalog)).toMatchObject({
      label: "GLM 5.3 Flash",
      providerId: "nan",
    });
    expect(findKnownModel("helmcode/gemma4", catalog)?.providerId).toBe("helmcode");
    // A route the catalog does not list keeps the glyph through the snapshot prefix.
    expect(findKnownModel("helmcode/not-a-model-yet")?.providerId).toBe("helmcode");
  });
});

describe("OpenCode Go on the opencode harness", () => {
  const catalog = live({
    "opencode-go": {
      "deepseek-v4.1-flash": {
        name: "DeepSeek V4.1 Flash",
        reasoning: true,
        limit: { context: 1_000_000 },
        reasoning_options: effort(["low", "high", "max"]),
      },
    },
  });
  const group = (groups: ReturnType<typeof modelGroupsForHarness>, provider: string) =>
    groups.find((g) => g.provider === provider);

  test("the opencode picker offers the Go group from the catalog", () => {
    const groups = modelGroupsForHarness("opencode", [], {}, null, catalog);
    const go = group(groups, "OpenCode Go");
    // No swarm env key: opencode authenticates Go through its own CLI login.
    expect(go).toMatchObject({ requiredKey: "", enabled: true });
    expect(go?.models.map((m) => m.id)).toContain("opencode-go/deepseek-v4.1-flash");
    expect(go?.models.find((m) => m.id === "opencode-go/deepseek-v4.1-flash")).toMatchObject({
      label: "DeepSeek V4.1 Flash",
      contextWindow: 1_000_000,
      providerId: null,
      reasoningLevels: ["low", "high", "max"],
    });
    expect(effortLevelsFor("opencode", "opencode-go/deepseek-v4.1-flash", catalog)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  test("the Go group comes from the bundled snapshot when no live catalog has resolved", () => {
    const go = group(modelGroupsForHarness("opencode", [], {}, null), "OpenCode Go");
    expect(go?.enabled).toBe(true);
    expect(go?.models.some((m) => m.id === "opencode-go/deepseek-v4-flash")).toBe(true);
  });

  test("the pi picker lists only the Go ids its worker resolves, gated on OPENCODE_API_KEY", () => {
    const withUnresolvable = live({
      "opencode-go": {
        "deepseek-v4.1-flash": {
          name: "DeepSeek V4.1 Flash",
          reasoning: true,
          limit: { context: 1_000_000 },
          reasoning_options: effort(["low", "high", "max"]),
        },
        "deepseek-v4-flash": { name: "DeepSeek V4 Flash", limit: { context: 1_000_000 } },
      },
    });
    const resolvable = ["deepseek-v4.1-flash", "glm-5.3"];
    const goFor = (presence: Record<string, boolean>, ids: string[] | null) =>
      group(modelGroupsForHarness("pi", [], presence, null, withUnresolvable, ids), "OpenCode Go");

    const locked = goFor({}, resolvable);
    expect(locked).toMatchObject({ requiredKey: "OPENCODE_API_KEY", enabled: false });

    const go = goFor({ OPENCODE_API_KEY: true }, resolvable);
    expect(go?.enabled).toBe(true);
    const ids = go?.models.map((m) => m.id) ?? [];
    expect(ids).toContain("opencode-go/deepseek-v4.1-flash");
    expect(ids).not.toContain("opencode-go/deepseek-v4-flash");
    expect(ids.every((id) => resolvable.includes(id.replace("opencode-go/", "")))).toBe(true);
    expect(go?.models.find((m) => m.id === "opencode-go/deepseek-v4.1-flash")).toMatchObject({
      requiredKey: "OPENCODE_API_KEY",
      reasoningLevels: ["low", "high", "max"],
    });

    // No worker report yet: the snapshot shows, but nothing is selectable.
    const awaiting = goFor({ OPENCODE_API_KEY: true }, null);
    expect(awaiting?.enabled).toBe(false);
    expect(awaiting?.disabledReason).toContain("Awaiting worker probe");
  });

  test("the opencode picker ignores the pi probe list", () => {
    const go = group(
      modelGroupsForHarness("opencode", [], {}, null, catalog, ["other-model"]),
      "OpenCode Go",
    );
    expect(go?.models.map((m) => m.id)).toContain("opencode-go/deepseek-v4.1-flash");
  });

  test("the closed providers (claude, codex) never list opencode-go", () => {
    for (const harness of ["claude", "codex"] as const) {
      const groups = modelGroupsForHarness(harness, [], {}, null, catalog);
      expect(groups.flatMap((g) => g.models).some((m) => m.id.startsWith("opencode-go/"))).toBe(
        false,
      );
    }
  });
});
