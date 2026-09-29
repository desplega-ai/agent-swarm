// The swarm app's test fixtures hand-copy the shipped tier defaults (apps/ui cannot import
// src/types at runtime). This keeps the copy honest, so the dial and effort tests in the app
// run against what a fresh deployment actually resolves.

import { describe, expect, test } from "bun:test";
import { DEFAULT_TIER_VALUES } from "../../apps/ui/src/lib/model-tier-fixtures";
import { DEFAULT_MODEL_TIER_MAP } from "../types";

describe("apps/ui tier fixtures", () => {
  test("mirror DEFAULT_MODEL_TIER_MAP for every provider the fixtures list", () => {
    for (const [provider, tiers] of Object.entries(DEFAULT_TIER_VALUES)) {
      expect(tiers).toEqual(
        DEFAULT_MODEL_TIER_MAP[provider as keyof typeof DEFAULT_MODEL_TIER_MAP] as never,
      );
    }
  });
});
