import { describe, expect, test } from "bun:test";
import {
  findKnownModel,
  pickDefaultModelForHarness,
} from "../../apps/ui/src/lib/agent-runtime-models";
import { loadModelsDevCache } from "../be/modelsdev-cache";
import { buildModelsDevSeedRows } from "../be/seed-pricing";

describe("Opus 5.5 registry", () => {
  test("defaults to Opus 5.5 and keeps Opus 5 selectable", () => {
    expect(pickDefaultModelForHarness("claude", [])).toBe("claude-opus-5-5");
    expect(findKnownModel("claude-opus-5-5")).toMatchObject({
      id: "claude-opus-5-5",
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    });
    expect(findKnownModel("claude-opus-5")?.id).toBe("claude-opus-5");
  });

  test("seeds canonical and alias rates without changing Opus 5", () => {
    const cache = loadModelsDevCache();
    expect(cache).not.toBeNull();
    const rows = buildModelsDevSeedRows(cache!);
    for (const provider of ["claude", "claude-managed"] as const) {
      for (const model of ["claude-opus-5-5", "opus"]) {
        const rates = Object.fromEntries(
          rows
            .filter((row) => row.provider === provider && row.model === model)
            .map((row) => [row.tokenClass, row.pricePerMillionUsd]),
        );
        expect(rates).toEqual({
          input: 4,
          output: 20,
          cached_input: 0.2,
          cache_write: 5,
          cache_write_1h: 8,
        });
      }
      expect(
        rows.find(
          (row) =>
            row.provider === provider &&
            row.model === "claude-opus-5" &&
            row.tokenClass === "input",
        )?.pricePerMillionUsd,
      ).toBe(5);
    }
  });
});
