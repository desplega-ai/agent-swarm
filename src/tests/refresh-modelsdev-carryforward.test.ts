// Pins the refresh script's carry-forward of models.dev-delisted models —
// the 2026-08 refresh silently dropped still-runnable models (gpt-5.1/5.2
// codex family, legacy anthropic ids), breaking context-window lookups and
// reasoning-effort gating. Delisting upstream is not retirement.

import { describe, expect, test } from "bun:test";
import { carryForwardDelistedModels } from "../../scripts/refresh-modelsdev-pricing";
import { FALLBACK_CODEX_MODEL_PRICING } from "../providers/codex-models";

describe("carryForwardDelistedModels", () => {
  test("models missing from the fresh fetch are carried forward; fresh data wins otherwise", () => {
    const prev = {
      openai: {
        models: {
          "gpt-old": { id: "gpt-old", cost: { input: 1 } },
          "gpt-kept": { id: "gpt-kept", cost: { input: 2 } },
        },
      },
    };
    const next = {
      openai: { models: { "gpt-kept": { id: "gpt-kept", cost: { input: 3 } } } },
    };
    const carried = carryForwardDelistedModels(prev, next);
    expect(carried).toBe(1);
    expect(next.openai.models["gpt-old"]).toEqual({ id: "gpt-old", cost: { input: 1 } });
    // Fresh data is untouched for listed models.
    expect(next.openai.models["gpt-kept"]?.cost?.input).toBe(3);
  });

  test("a provider entirely absent from the fresh fetch is restored", () => {
    const prev = { legacyprov: { models: { m1: { id: "m1" } } } };
    const next: Record<string, { models?: Record<string, { id?: string }> }> = {};
    expect(carryForwardDelistedModels(prev, next)).toBe(1);
    expect(next.legacyprov?.models?.m1).toEqual({ id: "m1" });
  });

  test("no previous snapshot or empty model blocks carry nothing", () => {
    expect(carryForwardDelistedModels(null, {})).toBe(0);
    expect(carryForwardDelistedModels({ p: {} }, { p: { models: {} } })).toBe(0);
  });
});

describe("FALLBACK_CODEX_MODEL_PRICING (advisory table)", () => {
  test("gpt-5.6 terra/luna carry the published rates", () => {
    // Direct assertions: through computeCodexCostUsd the models.dev snapshot
    // shadows this table, so drift here would otherwise go unnoticed.
    expect(FALLBACK_CODEX_MODEL_PRICING["gpt-5.6-terra"]).toEqual({
      inputPerMillion: 2.0,
      cachedInputPerMillion: 0.2,
      outputPerMillion: 12.0,
    });
    expect(FALLBACK_CODEX_MODEL_PRICING["gpt-5.6-luna"]).toEqual({
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.2,
    });
  });
});
