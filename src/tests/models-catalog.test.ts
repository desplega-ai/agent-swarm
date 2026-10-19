/**
 * Unit tests for the live model catalog (`src/be/models-catalog.ts`).
 *
 * Verifies:
 *  - `buildModelsCatalog` keeps only the harness/ACP-picker providers and slims
 *    each model down to the fields the UI reads.
 *  - `getModelsCatalog` falls back to the vendored snapshot before the first
 *    live update and prefers live data after one.
 *  - Pinned limited-availability entries survive a live payload that does not
 *    list them (re-merged from the vendored snapshot).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { reasoningLevelsForModel } from "@desplega/model-catalog";
import {
  buildModelsCatalog,
  type CatalogProviderId,
  getModelsCatalog,
  PINNED_MODELSDEV_ENTRIES,
  resetModelsCatalogForTests,
  updateLiveModelsCatalog,
} from "../be/models-catalog";
import type { ModelsDevCache } from "../be/modelsdev-cache";
import { getContextWindowSize } from "../utils/context-window";

afterEach(() => {
  resetModelsCatalogForTests();
});

const LIVE_CACHE: ModelsDevCache = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "test-vendor/test-model-live-only": {
        id: "test-vendor/test-model-live-only",
        name: "Test Model (live only)",
        cost: { input: 0.5, output: 1.5, cache_read: 0.1 },
        limit: { context: 256_000 },
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          // Malformed entry (no `type`) — must be filtered out by the slimmer.
          {},
        ],
      },
    },
  },
  // Not picker-reachable — must be dropped from the catalog.
  requesty: {
    models: { "some/model": { id: "some/model", cost: { input: 1, output: 2 } } },
  },
};

describe("buildModelsCatalog", () => {
  test("keeps only picker-reachable providers and slims model fields", () => {
    const catalog = buildModelsCatalog(LIVE_CACHE);

    expect(Object.keys(catalog)).toEqual(["openrouter"]);
    const model = catalog.openrouter?.models["test-vendor/test-model-live-only"];
    expect(model).toEqual({
      id: "test-vendor/test-model-live-only",
      name: "Test Model (live only)",
      cost: { input: 0.5, output: 1.5, cache_read: 0.1 },
      limit: { context: 256_000 },
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    });
  });

  test("falls back to the map key when a model entry has no id", () => {
    const catalog = buildModelsCatalog({
      openai: { models: { "gpt-keyed": { cost: { input: 1, output: 2 } } } },
    });
    expect(catalog.openai?.models["gpt-keyed"]?.id).toBe("gpt-keyed");
  });

  test("projects opencode-go (OpenCode Go) like its sibling opencode", () => {
    const catalog = buildModelsCatalog({
      requesty: { models: { ignored: { id: "ignored" } } },
      "opencode-go": {
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          "deepseek-v4.1-flash": {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            limit: { context: 1_000_000 },
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
          },
        },
      },
    });
    // A non-picker provider is dropped; opencode-go is kept.
    expect(Object.keys(catalog)).toEqual(["opencode-go"]);
    expect(catalog["opencode-go"]?.models["deepseek-v4.1-flash"]).toMatchObject({
      id: "deepseek-v4.1-flash",
      limit: { context: 1_000_000 },
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    });
  });
});

describe("getModelsCatalog", () => {
  test("serves the vendored snapshot before any live update", () => {
    const result = getModelsCatalog();
    expect(result.source).toBe("snapshot");
    expect(result.updatedAt).toBeNull();
    // The vendored snapshot always carries the picker providers.
    expect(Object.keys(result.providers.openrouter?.models ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(result.providers.anthropic?.models ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(result.providers.opencode?.models ?? {}).length).toBeGreaterThan(0);
    // OpenCode Go is a catalog provider too (its sibling `opencode` is Zen).
    expect(result.providers["opencode-go"]?.name).toBe("OpenCode Go");
    expect(result.providers["opencode-go"]?.models["deepseek-v4-flash"]?.limit?.context).toBe(
      1_000_000,
    );
    expect(result.providers.nan?.models["glm5.3-flash"]).toBeDefined();
    expect(Object.keys(result.providers.helmcode?.models ?? {}).sort()).toEqual([
      "deepseek-v4-flash",
      "gemma4",
      "glm5.3",
      "glm5.3-flash",
      "qwen3.6",
    ]);
  });

  test("prefers live data after an update", () => {
    updateLiveModelsCatalog(LIVE_CACHE, 1234);
    const result = getModelsCatalog();
    expect(result.source).toBe("live");
    expect(result.updatedAt).toBe(1234);
    expect(result.providers.openrouter?.models["test-vendor/test-model-live-only"]).toBeDefined();
  });

  test("re-merges pinned entries missing from the live payload", () => {
    // LIVE_CACHE has no anthropic provider at all — every anthropic pin must
    // be restored from the vendored snapshot.
    updateLiveModelsCatalog(LIVE_CACHE);
    const result = getModelsCatalog();
    for (const entryPath of PINNED_MODELSDEV_ENTRIES) {
      const slashIndex = entryPath.indexOf("/");
      const providerId = entryPath.slice(0, slashIndex) as CatalogProviderId;
      const modelId = entryPath.slice(slashIndex + 1);
      expect(result.providers[providerId]?.models[modelId]).toBeDefined();
    }
  });

  test("does not overwrite a live entry with the snapshot pin", () => {
    updateLiveModelsCatalog({
      ...LIVE_CACHE,
      anthropic: {
        models: {
          "claude-mythos-5": { id: "claude-mythos-5", name: "Live Mythos", cost: { input: 9 } },
        },
      },
    });
    const result = getModelsCatalog();
    expect(result.providers.anthropic?.models["claude-mythos-5"]?.name).toBe("Live Mythos");
  });
});

describe("nan and helmcode sections", () => {
  test("the registry-synthesized helmcode section survives a live payload that lacks it", () => {
    // LIVE_CACHE has no helmcode provider: the registry section is refilled.
    updateLiveModelsCatalog(LIVE_CACHE);
    const helmcode = getModelsCatalog().providers.helmcode;
    expect(helmcode?.id).toBe("helmcode");
    expect(helmcode?.name).toBe("Helmcode");
    expect(helmcode?.models["glm5.3"]?.limit?.context).toBe(1_048_576);
    expect(helmcode?.models["qwen3.6"]?.limit?.context).toBe(262_144);
  });

  test("reasoning levels resolve for helmcode and nan ids on pi and opencode", () => {
    const catalog = getModelsCatalog().providers;
    for (const harness of ["pi", "opencode"]) {
      expect(
        reasoningLevelsForModel(harness, "helmcode/glm5.3-flash", catalog).length,
      ).toBeGreaterThan(0);
      expect(reasoningLevelsForModel(harness, "nan/glm5.3-flash", catalog).length).toBeGreaterThan(
        0,
      );
    }
  });

  test("context windows come from the catalog sections", () => {
    expect(getContextWindowSize("helmcode/glm5.3")).toBe(1_048_576);
    expect(getContextWindowSize("helmcode/gemma4")).toBe(262_144);
    expect(getContextWindowSize("nan/qwen3.6")).toBe(262_144);
  });
});

describe("opencode-go section", () => {
  test("the snapshot gives opencode-go ids their context window, not the 200k fallback", () => {
    expect(getContextWindowSize("opencode-go/deepseek-v4-flash")).toBe(1_000_000);
  });

  test("opencode and pi keep the model's own max for an opencode-go id", () => {
    const catalog = getModelsCatalog().providers;
    // `deepseek-v4-flash` declares low|high|max and both harnesses pass it through.
    for (const harness of ["opencode", "pi"] as const) {
      expect(reasoningLevelsForModel(harness, "opencode-go/deepseek-v4-flash", catalog)).toEqual([
        "low",
        "high",
        "max",
      ]);
    }
  });
});
