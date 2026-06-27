import { describe, expect, test } from "bun:test";
import { normalizeOutcome } from "./normalize-outcome.ts";
import {
  aggregateScore,
  DEFAULT_PASS_THRESHOLD,
  dimensionScoreFromChecks,
  EFFICIENCY_DECAY_FACTOR,
  efficiencyScore,
  finalizeScore,
  type ScoredDimension,
  type WeightedValue,
} from "./scoring.ts";
import type { CheckResult, DeterministicCheck, OutcomeSpec } from "./types.ts";

/**
 * Pure-function coverage for the v8.0 OutcomeSpec v2 weighted aggregation:
 *  - dimensionScoreFromChecks: weighted mean of member graded-check values;
 *  - aggregateScore: Σ wᵢ·dimᵢ / Σ wᵢ, null on Σw=0 (legacy gates-only path);
 *  - finalizeScore: gate-fail-still-scores + threshold-on-aggregate semantics.
 * The throw→0 rule is exercised here at the value level (a thrown check yields
 * {pass:false} → value 0) and end-to-end in src/runner/scoring.test.ts.
 */

const v = (value: number, weight = 1): WeightedValue => ({ value, weight });
const dim = (subScore: number, weight = 1): ScoredDimension => ({ subScore, weight });

describe("dimensionScoreFromChecks — weighted mean of member checks", () => {
  test("single check = its value", () => {
    expect(dimensionScoreFromChecks([v(0.8)])).toBeCloseTo(0.8, 10);
  });

  test("equal weights → plain mean", () => {
    expect(dimensionScoreFromChecks([v(1), v(0)])).toBeCloseTo(0.5, 10);
    expect(dimensionScoreFromChecks([v(1), v(0.5), v(0)])).toBeCloseTo(0.5, 10);
  });

  test("per-check weights bias the mean", () => {
    // (3·1 + 1·0) / (3 + 1) = 0.75
    expect(dimensionScoreFromChecks([v(1, 3), v(0, 1)])).toBeCloseTo(0.75, 10);
  });

  test("a thrown check contributes value 0 (config's fault, not a crash)", () => {
    // A check that throws is mapped to {pass:false} → value 0 by the runner.
    expect(dimensionScoreFromChecks([v(1), v(0)])).toBeCloseTo(0.5, 10);
  });

  test("empty / zero-weight dimension → 0, never NaN", () => {
    expect(dimensionScoreFromChecks([])).toBe(0);
    expect(dimensionScoreFromChecks([v(1, 0), v(1, 0)])).toBe(0);
  });
});

describe("aggregateScore — Σ wᵢ·dimᵢ / Σ wᵢ", () => {
  test("two weighted dimensions", () => {
    // (2·1.0 + 1·0.4) / (2 + 1) = 2.4/3 = 0.8
    expect(aggregateScore([dim(1.0, 2), dim(0.4, 1)])).toBeCloseTo(0.8, 10);
  });

  test("equal weights → plain mean", () => {
    expect(aggregateScore([dim(0.9), dim(0.5), dim(0.7)])).toBeCloseTo(0.7, 10);
  });

  test("no dimensions → null (legacy gates-only path signal)", () => {
    expect(aggregateScore([])).toBeNull();
  });

  test("all-zero weight → null (divide-by-zero guard)", () => {
    expect(aggregateScore([dim(1, 0), dim(0.5, 0)])).toBeNull();
  });

  test("re-normalization: omitting a dimension divides by the REMAINING weight", () => {
    // Authored {correctness w2 = 0.9, efficiency w1}. When efficiency is dropped
    // (e.g. unpriced), the divisor is 2 (not 3): score = 0.9, not 1.8/3 = 0.6.
    expect(aggregateScore([dim(0.9, 2)])).toBeCloseTo(0.9, 10);
  });
});

describe("finalizeScore — gates + aggregate → score/passed", () => {
  test("all gates pass, aggregate ≥ threshold → passed", () => {
    const r = finalizeScore({
      allGatesPass: true,
      dimensions: [dim(1.0, 2), dim(0.4, 1)], // 0.8
      passThreshold: DEFAULT_PASS_THRESHOLD, // 0.75
    });
    expect(r.score).toBeCloseTo(0.8, 10);
    expect(r.passed).toBe(true);
  });

  test("all gates pass but aggregate < threshold → not passed (threshold gates the AGGREGATE)", () => {
    const r = finalizeScore({
      allGatesPass: true,
      dimensions: [dim(1.0, 1), dim(0.4, 1)], // 0.7
      passThreshold: 0.75,
    });
    expect(r.score).toBeCloseTo(0.7, 10);
    expect(r.passed).toBe(false);
  });

  test("a failing gate forces passed=false but the score is STILL computed/reported", () => {
    const r = finalizeScore({
      allGatesPass: false,
      dimensions: [dim(0.9, 1), dim(0.9, 1)], // 0.9 (well above threshold)
      passThreshold: 0.75,
    });
    expect(r.score).toBeCloseTo(0.9, 10); // score is NOT zeroed by the gate fail
    expect(r.passed).toBe(false); // …but the gate fail blocks the pass
  });

  test("legacy gates-only spec (no dimensions): score = binary gate verdict", () => {
    expect(finalizeScore({ allGatesPass: true, dimensions: [], passThreshold: 0.75 })).toEqual({
      score: 1,
      passed: true,
    });
    expect(finalizeScore({ allGatesPass: false, dimensions: [], passThreshold: 0.75 })).toEqual({
      score: 0,
      passed: false,
    });
  });

  test("threshold boundary is inclusive (score === threshold passes)", () => {
    const r = finalizeScore({
      allGatesPass: true,
      dimensions: [dim(0.75)],
      passThreshold: 0.75,
    });
    expect(r.passed).toBe(true);
  });
});

describe("efficiencyScore — deterministic decay vs budget (v8.0 §5)", () => {
  test("decay factor is 3 (full credit ≤ budget, 0 at 3× budget)", () => {
    expect(EFFICIENCY_DECAY_FACTOR).toBe(3);
  });

  test("observed ≤ budget → 1.0 (and under-budget clamps at 1, never > 1)", () => {
    expect(efficiencyScore(1.0, 1.0)).toBeCloseTo(1, 10); // exactly at budget
    expect(efficiencyScore(0.5, 1.0)).toBeCloseTo(1, 10); // half budget
    expect(efficiencyScore(0, 1.0)).toBeCloseTo(1, 10); // free
  });

  test("observed = N× budget → 0 (N = 3); beyond clamps at 0", () => {
    expect(efficiencyScore(3.0, 1.0)).toBeCloseTo(0, 10); // 3× budget
    expect(efficiencyScore(10.0, 1.0)).toBeCloseTo(0, 10); // way over → clamp 0
  });

  test("midpoint: 2× budget → 0.5 (linear decay between budget and N×)", () => {
    // overage = budget; divisor = (N-1)·budget = 2·budget → 1 - 0.5 = 0.5
    expect(efficiencyScore(2.0, 1.0)).toBeCloseTo(0.5, 10);
    // scale-invariant: same ratio, different units (ms)
    expect(efficiencyScore(120_000, 60_000)).toBeCloseTo(0.5, 10);
  });

  test("quarter-overage example: 1.5× budget → 0.75", () => {
    // overage = 0.5·budget; 1 - 0.5/2 = 0.75
    expect(efficiencyScore(1.5, 1.0)).toBeCloseTo(0.75, 10);
  });

  test("non-positive budget never divides by zero (defensive)", () => {
    expect(efficiencyScore(0, 0)).toBe(1); // observed ≤ 0 → full credit
    expect(efficiencyScore(0.1, 0)).toBe(0); // any spend over a 0 budget → 0
  });
});

describe("efficiency dimension re-normalization + dual-budget (v8.0 §5)", () => {
  test("unpriced efficiency → dimension dropped, divisor re-normalizes over the REMAINING weights", () => {
    // Authored {correctness w3 = 0.9, efficiency w1}. The attempt is unpriced
    // (costUsd null) and there is no time budget, so the runner drops the
    // efficiency dimension entirely. The aggregate is over correctness ONLY:
    // 0.9·3 / 3 = 0.9 — NOT 0.9·3 / 4 = 0.675 (efficiency is NOT scored 0).
    const withEfficiencyZeroed = aggregateScore([dim(0.9, 3), dim(0, 1)]);
    const reNormalized = aggregateScore([dim(0.9, 3)]); // efficiency omitted
    expect(withEfficiencyZeroed).toBeCloseTo(0.675, 10); // the WRONG behavior
    expect(reNormalized).toBeCloseTo(0.9, 10); // the correct re-normalized score
  });

  test("dual budget → efficiency sub-score is MIN(costScore, timeScore)", () => {
    // cost: $1.5 vs $1 budget → 0.75; time: 120s vs 60s budget → 0.5.
    const costScore = efficiencyScore(1.5, 1.0);
    const timeScore = efficiencyScore(120_000, 60_000);
    expect(costScore).toBeCloseTo(0.75, 10);
    expect(timeScore).toBeCloseTo(0.5, 10);
    // The runner takes the worst-case of the two.
    expect(Math.min(costScore, timeScore)).toBeCloseTo(0.5, 10);
  });
});

describe("v1 checks-only parity — normalizeOutcome + finalizeScore == legacy binary path", () => {
  // A v1 (pre-v8.0) OutcomeSpec authored with only `checks[]` and no judges must
  // keep the EXACT legacy binary verdict after the v8.0 rewrite:
  //   all checks pass  → passed=true,  score=1
  //   any check fails   → passed=false, score=0
  // normalizeOutcome maps `checks` → `gates` and produces ZERO dimensions, so
  // aggregateScore returns null and finalizeScore collapses to the binary gate
  // verdict — i.e. the score is NOT the weighted aggregate, it's `allGatesPass ?
  // 1 : 0`. This pins the back-compat guarantee that the normalization + scoring
  // round-trip never silently changes a v1 scenario's pass/fail.
  const check = (name: string): DeterministicCheck => ({
    name,
    fn: async (): Promise<CheckResult> => ({ pass: true }),
  });

  // The legacy binary path, stated once: a v1 attempt passed iff every gate
  // passed; its score was 1/0 with no partial credit and no threshold gating.
  const legacyVerdict = (allGatesPass: boolean) => ({
    score: allGatesPass ? 1 : 0,
    passed: allGatesPass,
  });

  // Run a v1 checks-only spec through the real v8.0 path and return the verdict.
  function v8Verdict(spec: OutcomeSpec, allGatesPass: boolean) {
    const n = normalizeOutcome(spec);
    // A checks-only v1 spec normalizes to gates + NO dimensions (the signal that
    // finalizeScore must use the legacy binary path, not the weighted aggregate).
    expect(n.dimensions).toEqual([]);
    return finalizeScore({
      allGatesPass,
      dimensions: n.dimensions.map((d) => ({ weight: d.weight, subScore: 0 })),
      passThreshold: n.passThreshold,
    });
  }

  const v1Spec: OutcomeSpec = { checks: [check("a"), check("b"), check("c")] };

  test("all checks pass → passed=true, score=1 (same as legacy)", () => {
    const v8 = v8Verdict(v1Spec, true);
    expect(v8).toEqual(legacyVerdict(true));
    expect(v8).toEqual({ score: 1, passed: true });
  });

  test("a check fails → passed=false, score=0 (same as legacy)", () => {
    const v8 = v8Verdict(v1Spec, false);
    expect(v8).toEqual(legacyVerdict(false));
    expect(v8).toEqual({ score: 0, passed: false });
  });

  test("the v8.0 default threshold never alters a checks-only v1 verdict", () => {
    // Legacy had no threshold; the gate-only path must ignore passThreshold
    // entirely (score is binary, so 1 >= 0.75 and the fail is gate-forced).
    const n = normalizeOutcome(v1Spec);
    expect(n.passThreshold).toBe(DEFAULT_PASS_THRESHOLD);
    expect(
      finalizeScore({ allGatesPass: true, dimensions: [], passThreshold: n.passThreshold }),
    ).toEqual(legacyVerdict(true));
    expect(
      finalizeScore({ allGatesPass: false, dimensions: [], passThreshold: n.passThreshold }),
    ).toEqual(legacyVerdict(false));
  });
});
