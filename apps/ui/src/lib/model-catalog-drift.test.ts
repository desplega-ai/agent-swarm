import { describe, expect, test } from "bun:test";
import {
  findKnownModel,
  type LiveModelsCatalog,
  modelGroupsForHarness,
  modelGroupsForSchedule,
  pickDefaultModelForHarness,
  pricingModelOptions,
} from "./agent-runtime-models";
import { DIAL_LEVELS, type DialHarness, dialPrice, dialSetting } from "./model-dial";
import { tierRows } from "./model-tier-fixtures";
import { modelVendor } from "./model-vendor";
import modelsCache from "./modelsdev-cache.json";

// The UI keeps a few concrete model ids (the pi/opencode default) and a table of
// vendor id patterns, and the dial reads the shipped model tier defaults
// (`tierRows()` mirrors them). None of them come from the catalog, so these
// tests fail when the bundled catalog moves under them. A failure here means:
// update the default / pattern, do not loosen the test.

type Snapshot = Record<string, { models: Record<string, { name?: string }> } | undefined>;
const snapshot = modelsCache as unknown as Snapshot;

const ENV_PRESENCE = { ANTHROPIC_API_KEY: true, OPENAI_API_KEY: true, OPENROUTER_API_KEY: true };

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

describe("dial levels against the bundled catalog", () => {
  const harnesses: DialHarness[] = ["claude", "codex", "pi", "opencode"];
  const tiers = tierRows();

  for (const harness of harnesses) {
    for (const level of DIAL_LEVELS) {
      test(`${harness} ${level} is a catalog model with a price and an effort`, () => {
        const setting = dialSetting(harness, level, { openrouter: false, tiers });
        expect(setting).not.toBeNull();
        expect(setting?.custom).toBe(false);
        expect(setting?.effort).not.toBeNull();
        expect(dialPrice(setting as NonNullable<typeof setting>)).not.toBeNull();
      });
    }
  }

  for (const level of DIAL_LEVELS) {
    test(`dsh ${level} (OpenRouter) is listed by the OpenRouter catalog`, () => {
      const model = dialSetting("dsh", level, { openrouter: true, tiers })?.model ?? "";
      expect(model.startsWith("openrouter/")).toBe(true);
      expect(snapshot.openrouter?.models[model.slice("openrouter/".length)]).toBeDefined();
    });

    test(`dsh ${level} (DeepSeek direct) is listed by the deepseek catalog`, () => {
      const model = dialSetting("dsh", level, { openrouter: false, tiers })?.model ?? "";
      expect(snapshot.deepseek?.models[model]).toBeDefined();
    });
  }
});

describe("vendor patterns against the bundled catalog", () => {
  test("every anthropic id maps to anthropic", () => {
    const stray = Object.keys(snapshot.anthropic?.models ?? {}).filter(
      (id) => modelVendor(id) !== "anthropic",
    );
    expect(stray).toEqual([]);
  });

  test("every openai id maps to openai", () => {
    const stray = Object.keys(snapshot.openai?.models ?? {}).filter(
      (id) => modelVendor(id) !== "openai",
    );
    expect(stray).toEqual([]);
  });

  test("an OpenRouter route reads as its maker, not as OpenRouter", () => {
    expect(modelVendor("openrouter/anthropic/claude-opus-5.5")).toBe("anthropic");
    expect(modelVendor("openrouter/deepseek/deepseek-v4.1-flash")).toBe("deepseek");
  });
});

describe("the live catalog wins over the bundled snapshot", () => {
  const liveAnthropic = live({
    anthropic: {
      "claude-opus-9-9": {
        name: "Claude Opus 9.9",
        release_date: "2030-01-01",
        limit: { context: 2_000_000 },
        cost: { input: 7, output: 35, cache_read: 0.7, cache_write: 8.75 },
        reasoning: true,
      },
      "claude-sonnet-9-9": { name: "Claude Sonnet 9.9", release_date: "2029-01-01" },
    },
  });

  test("findKnownModel names a model only the live catalog has", () => {
    expect(findKnownModel("claude-opus-9-9")).toBeNull();
    const known = findKnownModel("claude-opus-9-9", liveAnthropic);
    expect(known?.label).toBe("Claude Opus 9.9");
    expect(known?.contextWindow).toBe(2_000_000);
    expect(known?.cost).toEqual({ input: 7, output: 35, cache_read: 0.7, cache_write: 8.75 });
    expect(known?.releaseDate).toBe("2030-01-01");
  });

  test("a CLI shortname resolves to the newest live model", () => {
    expect(findKnownModel("opus", liveAnthropic)?.id).toBe("claude-opus-9-9");
    expect(findKnownModel("opus")?.id).not.toBe("claude-opus-9-9");
  });

  test("a reported label resolves through the live catalog", () => {
    const openrouter = live({
      openrouter: { "zed/test-model-1": { name: "Zed Lab: Test Model 1" } },
    });
    expect(findKnownModel("Zed Lab: Test Model 1")).toBeNull();
    expect(findKnownModel("Zed Lab: Test Model 1", openrouter)?.id).toBe(
      "openrouter/zed/test-model-1",
    );
  });

  test("the picker carries cache rates, status and release date from the catalog", () => {
    const withStatus = live({
      anthropic: {
        "claude-opus-9-9": { name: "Claude Opus 9.9", release_date: "2030-01-01", status: "beta" },
      },
    });
    const [group] = modelGroupsForHarness("claude", undefined, ENV_PRESENCE, null, liveAnthropic);
    expect(group.models[0]).toMatchObject({
      id: "claude-opus-9-9",
      releaseDate: "2030-01-01",
      cost: { cache_read: 0.7, cache_write: 8.75 },
    });
    const [flagged] = modelGroupsForHarness("claude", undefined, ENV_PRESENCE, null, withStatus);
    expect(flagged.models[0].status).toBe("beta");
  });

  test("claude defaults to the newest live Opus", () => {
    const fromLive = modelGroupsForHarness("claude", undefined, ENV_PRESENCE, null, liveAnthropic);
    expect(pickDefaultModelForHarness("claude", fromLive, liveAnthropic)).toBe("claude-opus-9-9");
    const fromSnapshot = modelGroupsForHarness("claude", undefined, ENV_PRESENCE, null, null);
    expect(pickDefaultModelForHarness("claude", fromSnapshot)).not.toBe("claude-opus-9-9");
  });

  test("a default the live catalog lost falls to the first current model", () => {
    const openrouter = live({
      openrouter: {
        "aaa/deprecated-one": { name: "A Deprecated", status: "deprecated" },
        "bbb/current-one": { name: "B Current" },
      },
    });
    const groups = modelGroupsForHarness("pi", undefined, ENV_PRESENCE, null, openrouter);
    expect(pickDefaultModelForHarness("pi", groups, openrouter)).toBe("openrouter/bbb/current-one");
  });

  test("dial settings follow the live catalog and are cached per catalog", () => {
    const tiers = tierRows({ "codex:regular": "gpt-9-test" });
    const withoutModel = live({ openai: { "gpt-9-other": { name: "Other", reasoning: true } } });
    const context = { openrouter: false, tiers, catalog: withoutModel };
    // The snapshot does not list gpt-9-test, nor does this live catalog: custom.
    expect(dialSetting("codex", "cheap", context)?.custom).toBe(true);
    expect(dialSetting("codex", "cheap", context)).toBe(dialSetting("codex", "cheap", context));
    // A different catalog object is a different cache.
    const withModel = live({
      openai: { "gpt-9-test": { name: "GPT-9 Test", reasoning: true, reasoning_options: [] } },
    });
    expect(
      dialSetting("codex", "cheap", { openrouter: false, tiers, catalog: withModel })?.custom,
    ).toBe(false);
  });

  test("dialPrice reads the live price", () => {
    const priced = live({ anthropic: { "claude-opus-5-5": { cost: { input: 1, output: 2 } } } });
    const setting = dialSetting("claude", "optimal", { openrouter: false, tiers: tierRows() });
    expect(setting?.model).toBe("claude-opus-5-5");
    expect(dialPrice(setting as NonNullable<typeof setting>, priced)).toEqual({
      input: 1,
      output: 2,
    });
    expect(dialPrice(setting as NonNullable<typeof setting>)).not.toEqual({ input: 1, output: 2 });
  });
});

describe("model lists that are not tied to one harness", () => {
  test("a schedule can name any catalog model, nothing is credential-locked", () => {
    const groups = modelGroupsForSchedule(null);
    expect(groups.map((g) => g.provider)).toEqual([
      "Claude CLI alias",
      "Anthropic",
      "OpenAI",
      "OpenRouter",
    ]);
    expect(groups.every((g) => g.enabled)).toBe(true);
  });

  test("the schedule aliases point at the live newest model", () => {
    const liveAnthropic = live({
      anthropic: { "claude-opus-9-9": { name: "Claude Opus 9.9", release_date: "2030-01-01" } },
    });
    const [aliases] = modelGroupsForSchedule(liveAnthropic);
    expect(aliases.models.find((m) => m.id === "opus")?.label).toContain("Claude Opus 9.9");
  });

  test("pricing suggestions use the ids the pricing table keys", () => {
    expect(pricingModelOptions("claude").every((m) => m.id.startsWith("claude-"))).toBe(true);
    expect(pricingModelOptions("codex").every((m) => m.id.startsWith("gpt-"))).toBe(true);
    const piIds = pricingModelOptions("pi").map((m) => m.id);
    expect(piIds.length).toBeGreaterThan(0);
    expect(piIds.every((id) => snapshot.openrouter?.models[id] !== undefined)).toBe(true);
    expect(pricingModelOptions("devin")).toEqual([]);
  });
});
