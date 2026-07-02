// Phase 6: codex adapter reads `reasoning_output_tokens` off `turn.completed`
// and stuffs it into CostData. Pre-fix the field was read into `lastUsage`
// but never propagated, so reasoning-model sessions silently under-billed.

import { describe, expect, test } from "bun:test";
import { computeCodexCostUsd } from "../../providers/codex-models";

describe("codex-models (Phase 6)", () => {
  test("known model still computes a non-zero cost from tokens", () => {
    const usd = computeCodexCostUsd("gpt-5.4", 1_000_000, 0, 0);
    expect(usd).toBeCloseTo(2.5, 5); // 1M input × $2.50/M
  });

  test("unknown model returns 0 (and logs a warning under the hood)", () => {
    const usd = computeCodexCostUsd("gpt-future-2027", 1_000_000, 0, 1_000_000);
    expect(usd).toBe(0);
  });
});
