/**
 * Unit tests for live-catalog preference in modelGroupsForHarness.
 *
 * Verifies:
 *  - A provider present in the live catalog (from GET /api/models-catalog)
 *    replaces that provider's build-time snapshot in the picker groups.
 *  - Providers absent from the live catalog keep their snapshot models
 *    (partial catalogs never blank a group).
 *  - No catalog at all (undefined/null) behaves exactly like before — the
 *    bundled snapshot backs every group.
 */

import { describe, expect, test } from "bun:test";
import {
  type LiveModelsCatalog,
  modelGroupsForHarness,
} from "../../apps/ui/src/lib/agent-runtime-models";

const LIVE_ONLY_MODEL_ID = "test-vendor/test-model-live-only";

const liveCatalog: LiveModelsCatalog = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      [LIVE_ONLY_MODEL_ID]: {
        id: LIVE_ONLY_MODEL_ID,
        name: "Test Model (live only)",
        cost: { input: 0.5, output: 1.5 },
        limit: { context: 256_000 },
      },
    },
  },
};

function openRouterGroup(groups: ReturnType<typeof modelGroupsForHarness>) {
  const group = groups.find((g) => g.provider === "OpenRouter");
  expect(group).toBeDefined();
  return group as NonNullable<typeof group>;
}

describe("modelGroupsForHarness — live catalog preference", () => {
  test("live catalog replaces the snapshot for providers it carries", () => {
    const groups = modelGroupsForHarness("pi", undefined, undefined, null, liveCatalog);
    const group = openRouterGroup(groups);
    expect(group.models).toHaveLength(1);
    const model = group.models[0];
    expect(model?.id).toBe(`openrouter/${LIVE_ONLY_MODEL_ID}`);
    expect(model?.label).toBe("Test Model (live only)");
    expect(model?.contextWindow).toBe(256_000);
  });

  test("providers absent from a partial live catalog fall back to the snapshot", () => {
    const groups = modelGroupsForHarness("pi", undefined, undefined, null, liveCatalog);
    const anthropic = groups.find((g) => g.provider === "Anthropic");
    expect(Object.keys(anthropic?.models ?? {}).length).toBeGreaterThan(0);
  });

  test("no live catalog keeps the bundled snapshot behaviour", () => {
    const groups = modelGroupsForHarness("pi", undefined, undefined, null);
    const group = openRouterGroup(groups);
    expect(group.models.length).toBeGreaterThan(0);
    expect(group.models.some((m) => m.id === `openrouter/${LIVE_ONLY_MODEL_ID}`)).toBe(false);
  });
});
