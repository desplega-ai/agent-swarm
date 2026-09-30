import { describe, expect, test } from "bun:test";
import type { LiveModelsCatalog } from "./agent-runtime-models";
import {
  DIAL_LEVELS,
  DIAL_TIER,
  type DialContext,
  dialLevelOfAnyHarness,
  dialMatches,
  dialSetting,
} from "./model-dial";
import { tierRows } from "./model-tier-fixtures";

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

const context = (overrides: Partial<DialContext> = {}): DialContext => ({
  openrouter: false,
  tiers: tierRows(),
  ...overrides,
});

describe("the dial reads the model tiers", () => {
  test("a level is the model of its tier: cheap regular, optimal smart, max ultra", () => {
    expect(DIAL_TIER).toEqual({ cheap: "regular", optimal: "smart", max: "ultra" });
    const tiers = tierRows({
      "codex:regular": "gpt-a",
      "codex:smart": "gpt-b",
      "codex:ultra": "gpt-c",
    });
    expect(DIAL_LEVELS.map((l) => dialSetting("codex", l, context({ tiers }))?.model)).toEqual([
      "gpt-a",
      "gpt-b",
      "gpt-c",
    ]);
  });

  test("a tier change changes the dial model with no code change", () => {
    const before = context({ tiers: tierRows() });
    const after = context({ tiers: tierRows({ "codex:smart": "gpt-next" }) });
    expect(dialSetting("codex", "optimal", before)?.model).toBe("gpt-5.6-sol");
    expect(dialSetting("codex", "optimal", after)?.model).toBe("gpt-next");
    // The stored model of the old tier no longer sits on the dial (Custom); the new one does.
    expect(dialMatches("codex", "gpt-5.6-sol", "high", after)).toEqual([]);
    expect(dialMatches("codex", "gpt-next", null, after)).toEqual(["optimal"]);
  });

  test("it uses the resolved model, and skips a latest: alias that resolved to nothing", () => {
    const rows = tierRows().map((row) =>
      row.provider === "codex" && row.tier === "smart"
        ? { ...row, resolvedModel: "gpt-resolved", alias: "latest:openai/gpt-*" }
        : row.provider === "codex" && row.tier === "ultra"
          ? { ...row, resolvedModel: null, defaultValue: "latest:openai/gpt-*" }
          : row,
    );
    expect(dialSetting("codex", "optimal", context({ tiers: rows }))?.model).toBe("gpt-resolved");
    expect(dialSetting("codex", "max", context({ tiers: rows }))).toBeNull();
  });

  test("it has no answer until the tiers load, and never guesses a model", () => {
    const loading = context({ tiers: null });
    for (const harness of ["claude", "codex", "pi", "opencode", "dsh"] as const) {
      for (const level of DIAL_LEVELS) expect(dialSetting(harness, level, loading)).toBeNull();
    }
    expect(dialMatches("codex", "gpt-5.6-sol", "high", loading)).toEqual([]);
    expect(dialLevelOfAnyHarness("gpt-5.6-sol", "high", loading)).toBeNull();
    // An empty list is loaded, with no rows: still nothing to write.
    expect(dialSetting("codex", "optimal", context({ tiers: [] }))).toBeNull();
  });

  test("a harness the tiers do not cover (no row) has no setting", () => {
    const tiers = tierRows().filter((row) => row.provider !== "pi");
    expect(dialSetting("pi", "optimal", context({ tiers }))).toBeNull();
    expect(dialSetting("opencode", "optimal", context({ tiers }))).not.toBeNull();
  });

  test("the answer is cached per catalog and per tier list", () => {
    const tiers = tierRows();
    const a = context({ tiers });
    expect(dialSetting("codex", "optimal", a)).toBe(dialSetting("codex", "optimal", a));
    // A new list with the same rows is a new cache; a changed row changes the answer.
    const changed = tierRows({ "codex:smart": "gpt-next" });
    expect(dialSetting("codex", "optimal", context({ tiers: changed }))?.model).toBe("gpt-next");
    expect(dialSetting("codex", "optimal", a)?.model).toBe("gpt-5.6-sol");
    expect(dialSetting("codex", "optimal", context({ tiers: null }))).toBeNull();
  });
});

describe("Claude tier values are CLI shortnames", () => {
  const anthropic = live({
    anthropic: {
      "claude-opus-9-9": { name: "Claude Opus 9.9", release_date: "2030-01-01", reasoning: true },
      "claude-opus-5-5": { name: "Claude Opus 5.5", release_date: "2026-05-01", reasoning: true },
      "claude-sonnet-9-1": { name: "Claude Sonnet 9.1", release_date: "2029-06-01" },
      "claude-fable-9": { name: "Claude Fable 9", release_date: "2029-09-01" },
    },
  });

  test("a shortname maps to the newest catalog id of its family", () => {
    const ctx = context({ catalog: anthropic });
    expect(dialSetting("claude", "cheap", ctx)?.model).toBe("claude-sonnet-9-1");
    expect(dialSetting("claude", "optimal", ctx)?.model).toBe("claude-opus-9-9");
    expect(dialSetting("claude", "max", ctx)?.model).toBe("claude-fable-9");
  });

  test("a canonical id passes through, and one the catalog lacks is custom", () => {
    const tiers = tierRows({ "claude:smart": "claude-opus-5-5", "claude:ultra": "claude-nope-1" });
    const ctx = context({ catalog: anthropic, tiers });
    expect(dialSetting("claude", "optimal", ctx)).toMatchObject({
      model: "claude-opus-5-5",
      custom: false,
    });
    expect(dialSetting("claude", "max", ctx)).toMatchObject({
      model: "claude-nope-1",
      custom: true,
      effort: null,
    });
  });

  test("the bundled snapshot answers while the live catalog loads", () => {
    const setting = dialSetting("claude", "optimal", context({ catalog: null }));
    expect(setting?.model).toMatch(/^claude-opus-/);
    expect(setting?.custom).toBe(false);
  });
});

describe("effort", () => {
  test("codex optimal and max can share a model and differ by effort", () => {
    const ctx = context();
    const optimal = dialSetting("codex", "optimal", ctx);
    const max = dialSetting("codex", "max", ctx);
    expect(optimal?.model).toBe(max?.model as string);
    expect(optimal?.effort).toBe("high");
    expect(max?.effort).toBe("xhigh");
    // The stored effort tells the two apart.
    expect(dialMatches("codex", "gpt-5.6-sol", "high", ctx)).toEqual(["optimal"]);
    expect(dialMatches("codex", "gpt-5.6-sol", "xhigh", ctx)).toEqual(["max"]);
    expect(dialLevelOfAnyHarness("gpt-5.6-sol", "xhigh", ctx)).toBe("max");
  });

  test("the intent is clamped to what the model accepts", () => {
    // Levels low and high only (models.dev lists no medium): medium falls to low.
    const catalog = live({
      openrouter: {
        "acme/lo-hi": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
        "acme/no-effort": { reasoning: false },
      },
    });
    const tiers = tierRows({
      "pi:regular": "openrouter/acme/lo-hi",
      "pi:smart": "openrouter/acme/lo-hi",
      "pi:ultra": "openrouter/acme/no-effort",
    });
    const ctx = context({ catalog, tiers });
    expect(dialSetting("pi", "cheap", ctx)?.effort).toBe("low");
    expect(dialSetting("pi", "optimal", ctx)?.effort).toBe("low");
    expect(dialSetting("pi", "max", ctx)?.effort).toBeNull();
  });

  test("claude keeps off out of the intent but takes it where the model has it", () => {
    const ctx = context();
    expect(dialSetting("claude", "cheap", ctx)?.effort).toBe("medium");
    expect(dialSetting("claude", "optimal", ctx)?.effort).toBe("high");
  });

  test("dsh writes no effort", () => {
    for (const level of DIAL_LEVELS) {
      expect(dialSetting("dsh", level, context({ openrouter: true }))?.effort).toBeNull();
    }
  });
});

describe("dsh", () => {
  test("with an OpenRouter key it runs the dsh tier models", () => {
    const tiers = tierRows({ "dsh:regular": "openrouter/acme/cheap-one" });
    const ctx = context({ openrouter: true, tiers });
    expect(DIAL_LEVELS.map((l) => dialSetting("dsh", l, ctx)?.model)).toEqual([
      "openrouter/acme/cheap-one",
      "openrouter/deepseek/deepseek-v4-pro-0813",
      "openrouter/anthropic/claude-opus-5.5",
    ]);
  });

  test("without one it runs the newest DeepSeek model of the tier's family", () => {
    const catalog = live({
      deepseek: {
        "deepseek-v5-flash": { release_date: "2030-02-01" },
        "deepseek-v4-flash": { release_date: "2026-07-31" },
        "deepseek-v4-flash-vision-exp": { release_date: "2031-01-01" },
        "deepseek-v4-pro": { release_date: "2026-08-12" },
        "deepseek-v3-pro": { release_date: "2025-01-01", status: "deprecated" },
        "deepseek-v9-pro": { release_date: "2035-01-01", status: "deprecated" },
      },
    });
    const ctx = context({ catalog });
    // flash: the newest id ending in -flash (not the -exp variant).
    expect(dialSetting("dsh", "cheap", ctx)?.model).toBe("deepseek-v5-flash");
    // pro: `deepseek-v4-pro-0813` names the pro family; a deprecated model is skipped.
    expect(dialSetting("dsh", "optimal", ctx)?.model).toBe("deepseek-v4-pro");
    // Max defaults to a Claude route (not a DeepSeek model): it takes Optimal's model.
    expect(dialSetting("dsh", "max", ctx)?.model).toBe("deepseek-v4-pro");
    expect(dialSetting("dsh", "max", ctx)?.custom).toBe(true);
  });

  test("DeepSeek direct follows a retuned tier without a literal id in source", () => {
    const tiers = tierRows({
      "dsh:regular": "openrouter/deepseek/deepseek-v4-pro",
      "dsh:smart": "openrouter/deepseek/deepseek-v4-flash",
    });
    const ctx = context({ tiers });
    expect(dialSetting("dsh", "cheap", ctx)?.model).toBe("deepseek-v4-pro");
    expect(dialSetting("dsh", "optimal", ctx)?.model).toBe("deepseek-v4-flash");
  });

  test("a tier that names no DeepSeek model at the lowest level has no direct setting", () => {
    const tiers = tierRows({ "dsh:regular": "openrouter/acme/cheap-one" });
    expect(dialSetting("dsh", "cheap", context({ tiers }))).toBeNull();
  });

  test("the two routes are cached apart", () => {
    const tiers = tierRows();
    const routed = dialSetting("dsh", "cheap", context({ openrouter: true, tiers }));
    const direct = dialSetting("dsh", "cheap", context({ openrouter: false, tiers }));
    expect(routed?.model.startsWith("openrouter/")).toBe(true);
    expect(direct?.model.startsWith("openrouter/")).toBe(false);
  });
});
