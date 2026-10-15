import { describe, expect, test } from "bun:test";
import { loadModelsDevCache } from "../be/modelsdev-cache";
import { buildModelsDevSeedRows } from "../be/seed-pricing";

function cachedInputRate(
  cache: Parameters<typeof buildModelsDevSeedRows>[0],
  provider: string,
  model: string,
) {
  return buildModelsDevSeedRows(cache).find(
    (row) => row.provider === provider && row.model === model && row.tokenClass === "cached_input",
  )?.pricePerMillionUsd;
}

// Sonnet 5.5 cache hits cost 0.05x input ($0.10/MTok), not the usual 0.1x.
describe("Sonnet 5.5 cache-read seed", () => {
  test("the vendored snapshot seeds $0.10 for every harness", () => {
    const cache = loadModelsDevCache();
    expect(cache).not.toBeNull();
    for (const provider of ["claude", "claude-managed", "amp", "cursor"]) {
      expect(cachedInputRate(cache!, provider, "claude-sonnet-5-5")).toBe(0.1);
    }
    expect(cachedInputRate(cache!, "claude", "sonnet")).toBe(0.1);
  });

  test("the shortname fallback seeds $0.10 when the snapshot lacks the model", () => {
    expect(cachedInputRate({ anthropic: { models: {} } }, "claude", "sonnet")).toBe(0.1);
  });
});
