import { describe, expect, test } from "bun:test";
import { loadModelsDevCache } from "../be/modelsdev-cache";
import { buildModelsDevSeedRows } from "../be/seed-pricing";

function ratesFor(provider: string, model: string) {
  const cache = loadModelsDevCache();
  expect(cache).not.toBeNull();
  return Object.fromEntries(
    buildModelsDevSeedRows(cache!)
      .filter((row) => row.provider === provider && row.model === model)
      .map((row) => [row.tokenClass, row.pricePerMillionUsd]),
  );
}

describe("Haiku 5.5 pricing seed", () => {
  test("seeds Anthropic rates for the claude harnesses, including the 1h cache write", () => {
    for (const provider of ["claude", "claude-managed"]) {
      expect(ratesFor(provider, "claude-haiku-5-5")).toEqual({
        input: 0.1,
        output: 0.5,
        cached_input: 0.01,
        cache_write: 0.125,
        cache_write_1h: 0.2,
      });
    }
  });

  test("seeds the same rates without a 1h class for amp and cursor", () => {
    for (const provider of ["amp", "cursor"]) {
      expect(ratesFor(provider, "claude-haiku-5-5")).toEqual({
        input: 0.1,
        output: 0.5,
        cached_input: 0.01,
        cache_write: 0.125,
      });
    }
  });
});
