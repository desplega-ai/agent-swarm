import { describe, expect, test } from "bun:test";
import { modelGroupsForHarness } from "../../apps/ui/src/lib/agent-runtime-models";
import { buildModelsCatalog } from "../be/models-catalog";
import cache from "../be/modelsdev-cache.json";
import { buildModelsDevSeedRows } from "../be/seed-pricing";
import {
  CODEX_DEFAULT_MODEL,
  computeCodexCostUsd,
  getCodexContextWindow,
  getCodexModelPricing,
  listCodexModels,
  resolveCodexModel,
} from "../providers/codex-models";
import { applyReasoningEffort, reasoningCapability } from "../providers/reasoning-effort";

const releases = [
  { id: "gpt-6-sol", label: "GPT-6 Sol", input: 2, output: 10, read: 0.2, write: 2.5 },
  { id: "gpt-6-luna", label: "GPT-6 Luna", input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
] as const;

for (const release of releases) {
  describe(release.id, () => {
    test("uses the exact bare CLI ID with verified context and base costs", () => {
      expect(listCodexModels()).toContain(release.id);
      expect(resolveCodexModel(release.id.toUpperCase())).toBe(release.id);
      expect(getCodexContextWindow(release.id)).toBe(1_050_000);
      expect(cache.openai.models[release.id].limit.output).toBe(128_000);
      expect(getCodexModelPricing(release.id)).toEqual({
        inputPerMillion: release.input,
        cachedInputPerMillion: release.read,
        outputPerMillion: release.output,
      });
      expect(computeCodexCostUsd(release.id, 1_000_000, 250_000, 100_000)).toBeCloseTo(
        release.input * 0.75 + release.read * 0.25 + release.output * 0.1,
        8,
      );
    });

    test("exposes the full reasoning range and transports none/max correctly", () => {
      expect(reasoningCapability("codex", release.id)).toEqual({
        supported: true,
        levels: ["off", "low", "medium", "high", "xhigh", "max"],
        default: "medium",
      });
      for (const [effort, value] of [
        ["off", "none"],
        ["max", "max"],
      ] as const) {
        expect(applyReasoningEffort("codex", release.id, effort)).toEqual({
          kind: "codex-config",
          config: { model_reasoning_effort: value },
        });
      }
    });

    test("seeds all four token classes under canonical Codex IDs", () => {
      const rows = buildModelsDevSeedRows(cache).filter(
        (row) => row.provider === "codex" && row.model === release.id,
      );
      expect(
        Object.fromEntries(rows.map((row) => [row.tokenClass, row.pricePerMillionUsd])),
      ).toEqual({
        input: release.input,
        output: release.output,
        cached_input: release.read,
        cache_write: release.write,
      });
      expect(cache.openai.models[release.id].cost.tiers).toEqual([
        {
          input: release.input * 2,
          output: release.output * 1.5,
          cache_read: release.read * 2,
          cache_write: release.write * 2,
          tier: { type: "context", size: 272000 },
        },
      ]);
    });

    test("is available through the catalog and direct UI selector", () => {
      const model = buildModelsCatalog(cache).openai?.models[release.id];
      expect(model?.limit?.context).toBe(1_050_000);
      expect(model?.cost).toMatchObject({ input: release.input, output: release.output });
      const option = modelGroupsForHarness("codex", undefined, undefined)
        .flatMap((group) => group.models)
        .find((entry) => entry.id === release.id);
      expect(option?.label).toBe(release.label);
      expect(option?.reasoningLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    });
  });
}

test("release additions preserve rollout-safe defaults and aliases", () => {
  expect(CODEX_DEFAULT_MODEL).toBe("gpt-5.6-terra");
  expect(resolveCodexModel("sonnet")).toBe("gpt-5.6-terra");
  expect(resolveCodexModel("haiku")).toBe("gpt-5.6-luna");
  expect(resolveCodexModel("opus")).toBe("gpt-5.6-sol");
});

describe("gpt-6.1-sol", () => {
  const id = "gpt-6.1-sol";

  test("uses the exact bare CLI ID with verified context and base costs", () => {
    expect(listCodexModels()).toContain(id);
    expect(resolveCodexModel("GPT-6.1-SOL")).toBe(id);
    expect(getCodexContextWindow(id)).toBe(1_050_000);
    expect(cache.openai.models[id].limit.output).toBe(128_000);
    expect(getCodexModelPricing(id)).toEqual({
      inputPerMillion: 2,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 10,
    });
    expect(computeCodexCostUsd(id, 1_000_000, 250_000, 100_000)).toBeCloseTo(
      2 * 0.75 + 0.1 * 0.25 + 10 * 0.1,
      8,
    );
  });

  test("exposes low through max without an off level", () => {
    expect(reasoningCapability("codex", id)).toEqual({
      supported: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
      default: "medium",
    });
    expect(applyReasoningEffort("codex", id, "max")).toEqual({
      kind: "codex-config",
      config: { model_reasoning_effort: "max" },
    });
  });

  test("seeds all four token classes with long-context tiers", () => {
    const rows = buildModelsDevSeedRows(cache).filter(
      (row) => row.provider === "codex" && row.model === id,
    );
    expect(Object.fromEntries(rows.map((row) => [row.tokenClass, row.pricePerMillionUsd]))).toEqual(
      { input: 2, output: 10, cached_input: 0.1, cache_write: 2.5 },
    );
    expect(cache.openai.models[id].cost.tiers).toEqual([
      {
        input: 4,
        output: 15,
        cache_read: 0.2,
        cache_write: 5,
        tier: { type: "context", size: 272000 },
      },
    ]);
  });

  test("is available through the catalog and direct UI selector", () => {
    const model = buildModelsCatalog(cache).openai?.models[id];
    expect(model?.limit?.context).toBe(1_050_000);
    expect(model?.cost).toMatchObject({ input: 2, output: 10 });
    const option = modelGroupsForHarness("codex", undefined, undefined)
      .flatMap((group) => group.models)
      .find((entry) => entry.id === id);
    expect(option?.label).toBe("GPT-6.1 Sol");
    expect(option?.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
