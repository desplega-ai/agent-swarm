import { describe, expect, test } from "bun:test";
import type { TokenTotals } from "../types.ts";
import { listOpenrouterModels, lookupModelCost, type PricedModel, priceUsage } from "./pricing.ts";

describe("lookupModelCost", () => {
  test("pi: openrouter-prefixed id resolves in the openrouter section", async () => {
    const m = await lookupModelCost("pi", "openrouter/deepseek/deepseek-v4-flash");
    expect(m).not.toBeNull();
    expect(m?.id).toBe("deepseek/deepseek-v4-flash");
    expect(m?.inputPerM).toBe(0.0983);
  });

  test("opencode: bare openrouter id resolves directly", async () => {
    const m = await lookupModelCost("opencode", "deepseek/deepseek-v4-flash");
    expect(m?.inputPerM).toBe(0.0983);
  });

  test("claude: date-suffixed id resolves via date-strip", async () => {
    const m = await lookupModelCost("claude", "claude-haiku-4-5-20251001");
    expect(m).not.toBeNull();
    expect(m?.id).toBe("claude-haiku-4-5");
    expect(m?.inputPerM).not.toBeNull();
  });

  test("claude: bare aliases resolve to the latest family member (v7 §8)", async () => {
    const haiku = await lookupModelCost("claude", "haiku");
    expect(haiku?.id).toBe("claude-haiku-4-5");
    const fable = await lookupModelCost("claude", "fable");
    expect(fable?.id).toBe("claude-fable-5");
  });

  test("unknown shortnames still return null", async () => {
    expect(await lookupModelCost("claude", "no-such-family")).toBeNull();
    // alias resolution is claude-only — codex never aliases
    expect(await lookupModelCost("codex", "fable")).toBeNull();
  });
});

describe("priceUsage", () => {
  const model: PricedModel = {
    id: "test/model",
    name: "Test Model",
    reasoning: false,
    toolCall: true,
    context: 200_000,
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheWritePerM: 1.25,
  };
  const usage: TokenTotals = {
    model: "test/model",
    inputTokens: 1000,
    outputTokens: 1000,
    cacheReadTokens: 1000,
    cacheWriteTokens: 1000,
  };

  test("anthropic semantics: input excludes cache tokens", () => {
    // 1000*1 + 1000*0.1 + 1000*1.25 + 1000*5 = 7350 → /1e6
    expect(priceUsage(model, usage, { inputIncludesCacheRead: false })).toBeCloseTo(0.00735, 10);
  });

  test("openai semantics: input includes cached tokens", () => {
    // uncached = 1000-1000 = 0; 0 + 100 + 1250 + 5000 = 6350 → /1e6
    expect(priceUsage(model, usage, { inputIncludesCacheRead: true })).toBeCloseTo(0.00635, 10);
  });

  test("cacheReadPerM falls back to inputPerM, cacheWritePerM to 0", () => {
    const m = { ...model, cacheReadPerM: null, cacheWritePerM: null };
    // 1000*1 + 1000*1 + 0 + 1000*5 = 7000 → /1e6
    expect(priceUsage(m, usage, { inputIncludesCacheRead: false })).toBeCloseTo(0.007, 10);
  });

  test("returns null when inputPerM or outputPerM is null", () => {
    expect(
      priceUsage({ ...model, inputPerM: null }, usage, { inputIncludesCacheRead: false }),
    ).toBeNull();
    expect(
      priceUsage({ ...model, outputPerM: null }, usage, { inputIncludesCacheRead: false }),
    ).toBeNull();
  });
});

describe("listOpenrouterModels", () => {
  test("returns the openrouter section sorted by name", async () => {
    const models = await listOpenrouterModels();
    expect(models.length).toBeGreaterThan(100);
    const pro = models.find((m) => m.id === "deepseek/deepseek-v4-pro");
    expect(pro?.inputPerM).toBe(0.435);
    expect(pro?.outputPerM).toBe(0.87);
    const names = models.map((m) => m.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});
