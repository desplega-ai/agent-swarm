/**
 * Unit tests for the live model catalog (`src/be/models-catalog.ts`).
 *
 * Verifies:
 *  - `buildModelsCatalog` keeps only the picker-reachable providers and slims
 *    each model down to the fields the UI reads.
 *  - `getModelsCatalog` falls back to the vendored snapshot before the first
 *    live update and prefers live data after one.
 *  - Pinned limited-availability entries survive a live payload that does not
 *    list them (re-merged from the vendored snapshot).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildModelsCatalog,
  getModelsCatalog,
  PINNED_MODELSDEV_ENTRIES,
  resetModelsCatalogForTests,
  updateLiveModelsCatalog,
} from "../be/models-catalog";
import type { ModelsDevCache } from "../be/modelsdev-cache";

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
      cost: { input: 0.5, output: 1.5 },
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
});

describe("getModelsCatalog", () => {
  test("serves the vendored snapshot before any live update", () => {
    const result = getModelsCatalog();
    expect(result.source).toBe("snapshot");
    expect(result.updatedAt).toBeNull();
    // The vendored snapshot always carries the picker providers.
    expect(Object.keys(result.providers.openrouter?.models ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(result.providers.anthropic?.models ?? {}).length).toBeGreaterThan(0);
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
      const providerId = entryPath.slice(0, slashIndex) as "anthropic" | "amazon-bedrock";
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
