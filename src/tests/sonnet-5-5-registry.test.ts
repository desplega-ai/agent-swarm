import { describe, expect, test } from "bun:test";
import { findKnownModel } from "../../apps/ui/src/lib/agent-runtime-models";
import { loadModelsDevCache } from "../be/modelsdev-cache";
import { buildModelsDevSeedRows } from "../be/seed-pricing";

describe("Sonnet 5.5 registry", () => {
  test("is selectable and keeps Sonnet 5 selectable", () => {
    expect(findKnownModel("claude-sonnet-5-5")).toMatchObject({
      id: "claude-sonnet-5-5",
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    });
    expect(findKnownModel("claude-sonnet-5")?.id).toBe("claude-sonnet-5");
  });

  test("seeds canonical and alias rates without changing Sonnet 5", () => {
    const cache = loadModelsDevCache();
    expect(cache).not.toBeNull();
    const rows = buildModelsDevSeedRows(cache!);
    for (const provider of ["claude", "claude-managed"] as const) {
      for (const model of ["claude-sonnet-5-5", "sonnet"]) {
        const rates = Object.fromEntries(
          rows
            .filter((row) => row.provider === provider && row.model === model)
            .map((row) => [row.tokenClass, row.pricePerMillionUsd]),
        );
        expect(rates).toEqual({
          input: 2,
          output: 10,
          cached_input: 0.2,
          cache_write: 2.5,
          cache_write_1h: 4,
        });
      }
      expect(
        rows.find(
          (row) =>
            row.provider === provider &&
            row.model === "claude-sonnet-5" &&
            row.tokenClass === "input",
        )?.pricePerMillionUsd,
      ).toBe(2);
    }
  });
});
