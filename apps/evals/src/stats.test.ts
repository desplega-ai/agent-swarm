import { describe, expect, test } from "bun:test";
import {
  bootstrapCI,
  bootstrapDiffCI,
  bootstrapRankSpread,
  meanOrNull,
  pairedBootstrapDiffCI,
  passAtK,
  passPowK,
  stratifiedBootstrapCI,
  wilsonInterval,
} from "./stats.ts";

describe("wilsonInterval", () => {
  test("3/5 passes ≈ [0.23, 0.88] (known fixture)", () => {
    const ci = wilsonInterval(3, 5);
    expect(ci.lo).toBeCloseTo(0.235, 2);
    expect(ci.hi).toBeCloseTo(0.879, 2);
    expect(ci.lo).toBeLessThan(0.6);
    expect(ci.hi).toBeGreaterThan(0.6);
  });

  test("all-pass (5/5): hi pinned to 1, lo strictly below 1", () => {
    const ci = wilsonInterval(5, 5);
    expect(ci.hi).toBeCloseTo(1, 5);
    expect(ci.lo).toBeGreaterThan(0);
    expect(ci.lo).toBeLessThan(1);
  });

  test("all-fail (0/5): lo pinned to 0, hi strictly above 0", () => {
    const ci = wilsonInterval(0, 5);
    expect(ci.lo).toBeCloseTo(0, 5);
    expect(ci.hi).toBeGreaterThan(0);
    expect(ci.hi).toBeLessThan(1);
  });

  test("total === 0 → [0, 0] (never NaN)", () => {
    const ci = wilsonInterval(0, 0);
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBe(0);
  });

  test("interval narrows as total grows at the same proportion (3/5 vs 30/50)", () => {
    const small = wilsonInterval(3, 5);
    const large = wilsonInterval(30, 50);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  test("bounds always inside [0, 1]", () => {
    for (const [p, n] of [
      [0, 1],
      [1, 1],
      [7, 10],
      [10, 10],
    ] as const) {
      const ci = wilsonInterval(p, n);
      expect(ci.lo).toBeGreaterThanOrEqual(0);
      expect(ci.hi).toBeLessThanOrEqual(1);
      expect(ci.lo).toBeLessThanOrEqual(ci.hi);
    }
  });
});

describe("bootstrapCI", () => {
  // Same per-attempt score distribution repeated; n=10 must give a tighter band.
  const base = [0.4, 0.6, 0.5, 0.7, 0.3];
  const n3 = [0.4, 0.6, 0.5];
  const n10 = [...base, ...base];

  test("CI narrows as n grows (n=10 tighter than n=3 on the same distribution)", () => {
    const w3 = bootstrapCI(n3, { seed: 42 });
    const w10 = bootstrapCI(n10, { seed: 42 });
    const width3 = w3.hi - w3.lo;
    const width10 = w10.hi - w10.lo;
    expect(width10).toBeLessThan(width3);
  });

  test("deterministic seed → identical bounds across runs", () => {
    const a = bootstrapCI(n10, { seed: 123 });
    const b = bootstrapCI(n10, { seed: 123 });
    expect(a.lo).toBe(b.lo);
    expect(a.hi).toBe(b.hi);
    expect(a.method).toBe("bootstrap");
  });

  test("different seeds give close-but-distinct bounds (proves it's not a constant)", () => {
    const a = bootstrapCI(n10, { seed: 1 });
    const b = bootstrapCI(n10, { seed: 2 });
    // Not identical (PRNG-driven), but both near the true mean (0.5).
    expect(a.lo).not.toBe(b.lo);
    expect(Math.abs(a.lo - b.lo)).toBeLessThan(0.15);
  });

  test("CI brackets the sample mean", () => {
    const ci = bootstrapCI(n10, { seed: 7 });
    const mean = n10.reduce((s, x) => s + x, 0) / n10.length;
    expect(ci.lo).toBeLessThanOrEqual(mean);
    expect(ci.hi).toBeGreaterThanOrEqual(mean);
  });

  test("edge: n=0 → [0, 0]", () => {
    const ci = bootstrapCI([]);
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBe(0);
    expect(ci.method).toBe("bootstrap");
  });

  test("edge: n=1 → degenerate [x, x]", () => {
    const ci = bootstrapCI([0.42]);
    expect(ci.lo).toBeCloseTo(0.42, 10);
    expect(ci.hi).toBeCloseTo(0.42, 10);
  });

  test("edge: all-equal scores → zero-width interval", () => {
    const ci = bootstrapCI([0.8, 0.8, 0.8, 0.8]);
    expect(ci.lo).toBeCloseTo(0.8, 10);
    expect(ci.hi).toBeCloseTo(0.8, 10);
  });

  test("edge: all-pass (all 1.0) and all-fail (all 0.0) stay in [0, 1]", () => {
    const allPass = bootstrapCI([1, 1, 1, 1, 1], { seed: 9 });
    const allFail = bootstrapCI([0, 0, 0, 0, 0], { seed: 9 });
    expect(allPass.lo).toBeCloseTo(1, 10);
    expect(allPass.hi).toBeCloseTo(1, 10);
    expect(allFail.lo).toBeCloseTo(0, 10);
    expect(allFail.hi).toBeCloseTo(0, 10);
  });

  test("bounds always inside [0, 1] and ordered", () => {
    const ci = bootstrapCI([0.1, 0.9, 0.5, 0.2, 0.95], { seed: 3 });
    expect(ci.lo).toBeGreaterThanOrEqual(0);
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(ci.lo).toBeLessThanOrEqual(ci.hi);
  });
});

describe("bootstrapDiffCI", () => {
  // Frontier clearly above budget — the gap should be significant at this n.
  const frontier = [0.9, 0.92, 0.88, 0.95, 0.9];
  const budget = [0.1, 0.15, 0.05, 0.2, 0.12];

  test("clearly-separated cohorts → CI excludes 0 (significant)", () => {
    const d = bootstrapDiffCI(frontier, budget, { seed: 0xc0ffee });
    expect(d.diff).toBeCloseTo(0.786, 2);
    expect(d.lo).toBeGreaterThan(0);
    expect(d.significant).toBe(true);
  });

  test("overlapping cohorts (same mean) → CI straddles 0 (not significant)", () => {
    const a = [0.4, 0.6, 0.5];
    const b = [0.5, 0.4, 0.6];
    const d = bootstrapDiffCI(a, b, { seed: 0xc0ffee });
    expect(d.diff).toBeCloseTo(0, 10);
    expect(d.lo).toBeLessThan(0);
    expect(d.hi).toBeGreaterThan(0);
    expect(d.significant).toBe(false);
  });

  test("negative diff is NOT clamped to 0 and can be significant (hi < 0)", () => {
    // a below b → diff negative; bounds are unclamped (unlike bootstrapCI).
    const d = bootstrapDiffCI(budget, frontier, { seed: 0xc0ffee });
    expect(d.diff).toBeCloseTo(-0.786, 2);
    expect(d.hi).toBeLessThan(0);
    expect(d.significant).toBe(true);
  });

  test("significant flag matches (lo > 0 || hi < 0)", () => {
    const d = bootstrapDiffCI(frontier, budget, { seed: 7 });
    expect(d.significant).toBe(d.lo > 0 || d.hi < 0);
  });

  test("deterministic seed → identical bounds across runs", () => {
    const a = bootstrapDiffCI(frontier, budget, { seed: 123 });
    const b = bootstrapDiffCI(frontier, budget, { seed: 123 });
    expect(a.lo).toBe(b.lo);
    expect(a.hi).toBe(b.hi);
    expect(a.diff).toBe(b.diff);
  });

  test("edge: either cohort empty → diff 0, [0, 0], not significant", () => {
    expect(bootstrapDiffCI([], budget)).toEqual({
      lo: 0,
      hi: 0,
      diff: 0,
      significant: false,
    });
    expect(bootstrapDiffCI(frontier, []).significant).toBe(false);
  });
});

describe("meanOrNull", () => {
  test("empty → null, non-empty → mean", () => {
    expect(meanOrNull([])).toBeNull();
    expect(meanOrNull([0.2, 0.4, 0.6])).toBeCloseTo(0.4, 10);
  });
});

describe("passPowK (unbiased pass^k)", () => {
  test("hand-computed: C(c,k)/C(n,k)", () => {
    // 4 of 5 pass, k=3: C(4,3)/C(5,3) = 4/10.
    expect(passPowK(4, 5, 3)).toBeCloseTo(0.4, 12);
    // 2 of 3 pass, k=2: C(2,2)/C(3,2) = 1/3.
    expect(passPowK(2, 3, 2)).toBeCloseTo(1 / 3, 12);
    // 3 of 6 pass, k=2: C(3,2)/C(6,2) = 3/15.
    expect(passPowK(3, 6, 2)).toBeCloseTo(0.2, 12);
  });

  test("k=1 is the plain pass rate; all pass is 1; fewer passes than k is 0", () => {
    expect(passPowK(3, 8, 1)).toBeCloseTo(3 / 8, 12);
    expect(passPowK(5, 5, 4)).toBe(1);
    expect(passPowK(2, 6, 3)).toBe(0);
    expect(passPowK(0, 4, 2)).toBe(0);
  });

  test("undefined (null) when the cell has fewer than k attempts or bad input", () => {
    expect(passPowK(2, 2, 3)).toBeNull();
    expect(passPowK(1, 4, 0)).toBeNull();
    expect(passPowK(1, 4, 1.5)).toBeNull();
    expect(passPowK(5, 4, 2)).toBeNull();
    expect(passPowK(-1, 4, 2)).toBeNull();
  });
});

describe("passAtK (unbiased pass@k)", () => {
  test("hand-computed: 1 - C(n-c,k)/C(n,k)", () => {
    // 2 of 5 pass, k=2: 1 - C(3,2)/C(5,2) = 1 - 3/10.
    expect(passAtK(2, 5, 2)).toBeCloseTo(0.7, 12);
    // 1 of 4 pass, k=3: 1 - C(3,3)/C(4,3) = 1 - 1/4.
    expect(passAtK(1, 4, 3)).toBeCloseTo(0.75, 12);
  });

  test("k=1 equals pass^1; fewer failures than k is 1; none passing is 0", () => {
    expect(passAtK(3, 8, 1)).toBeCloseTo(passPowK(3, 8, 1) as number, 12);
    expect(passAtK(4, 5, 2)).toBe(1);
    expect(passAtK(0, 5, 3)).toBe(0);
    expect(passAtK(1, 2, 3)).toBeNull();
  });
});

describe("stratifiedBootstrapCI", () => {
  test("point estimate is the mean of per-stratum means, not of all attempts", () => {
    // Stratum means 1 and 0; pooled mean would be 10/11.
    const r = stratifiedBootstrapCI([Array(10).fill(1), [0]]);
    expect(r.mean).toBeCloseTo(0.5, 12);
  });

  test("deterministic, and the CI narrows as attempts per stratum grow", () => {
    const few = [[0, 1, 0, 1]];
    const many = [Array.from({ length: 40 }, (_, i) => i % 2)];
    const a = stratifiedBootstrapCI(few);
    expect(stratifiedBootstrapCI(few)).toEqual(a);
    const b = stratifiedBootstrapCI(many);
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
    expect(a.lo).toBeLessThanOrEqual(0.5);
    expect(a.hi).toBeGreaterThanOrEqual(0.5);
  });

  test("single-attempt strata and all-equal strata collapse to the mean", () => {
    const r = stratifiedBootstrapCI([[0.2], [0.8]]);
    expect(r).toEqual({ mean: 0.5, lo: 0.5, hi: 0.5, method: "bootstrap" });
    expect(
      stratifiedBootstrapCI([
        [1, 1, 1],
        [1, 1],
      ]).lo,
    ).toBe(1);
  });

  test("no data → null mean, [0, 0]; empty strata are skipped", () => {
    expect(stratifiedBootstrapCI([])).toEqual({ mean: null, lo: 0, hi: 0, method: "bootstrap" });
    expect(stratifiedBootstrapCI([[], []]).mean).toBeNull();
    expect(stratifiedBootstrapCI([[], [0.4]]).mean).toBeCloseTo(0.4, 12);
  });

  test("variation across scenarios does not widen the CI, only attempt noise does", () => {
    // Scenario means 0 and 1 are far apart but each is perfectly stable: no CI width.
    const r = stratifiedBootstrapCI([
      [0, 0, 0],
      [1, 1, 1],
    ]);
    expect(r.mean).toBe(0.5);
    expect(r.hi - r.lo).toBe(0);
  });
});

describe("bootstrapRankSpread", () => {
  const strong = [[0.9, 0.95, 0.9, 0.92, 0.9]];
  const mid = [[0.5, 0.55, 0.5, 0.52, 0.5]];
  const weak = [[0.1, 0.15, 0.1, 0.12, 0.1]];

  test("well-separated groups keep a fixed rank", () => {
    const [a, b, c] = bootstrapRankSpread([weak, strong, mid]);
    expect(b).toEqual({ lo: 1, hi: 1, median: 1 });
    expect(c).toEqual({ lo: 2, hi: 2, median: 2 });
    expect(a).toEqual({ lo: 3, hi: 3, median: 3 });
  });

  test("overlapping groups get a wide, symmetric spread", () => {
    const noisy = [[0, 1, 0, 1, 1, 0]];
    const also = [[1, 0, 1, 0, 0, 1]];
    const [a, b] = bootstrapRankSpread([noisy, also]);
    expect(a?.lo).toBe(1);
    expect(a?.hi).toBe(2);
    expect(b?.lo).toBe(1);
    expect(b?.hi).toBe(2);
  });

  test("groups with no data get null and do not disturb the others", () => {
    const out = bootstrapRankSpread([strong, [], mid]);
    expect(out[1]).toBeNull();
    expect(out[0]).toEqual({ lo: 1, hi: 1, median: 1 });
    expect(out[2]).toEqual({ lo: 2, hi: 2, median: 2 });
    expect(bootstrapRankSpread([])).toEqual([]);
  });

  test("deterministic", () => {
    const g = [[[0, 1, 0, 1]], [[1, 1, 0, 1]], [[0, 0, 0, 1]]];
    expect(bootstrapRankSpread(g)).toEqual(bootstrapRankSpread(g));
  });
});

describe("pairedBootstrapDiffCI", () => {
  test("resamples pairs: a shared per-item offset cancels, the independent version widens", () => {
    // Items differ a lot in difficulty (0.1..0.9) but a beats b by a steady 0.05.
    const b = [0.1, 0.3, 0.5, 0.7, 0.9, 0.2, 0.6];
    const a = b.map((x) => x + 0.05);
    const paired = pairedBootstrapDiffCI(a, b);
    expect(paired.diff).toBeCloseTo(0.05, 12);
    expect(paired.lo).toBeCloseTo(0.05, 9);
    expect(paired.hi).toBeCloseTo(0.05, 9);
    expect(paired.significant).toBe(true);
    // Independent resampling cannot see the pairing and straddles 0.
    const unpaired = bootstrapDiffCI(a, b);
    expect(unpaired.significant).toBe(false);
    expect(unpaired.hi - unpaired.lo).toBeGreaterThan(0.2);
  });

  test("mixed-sign differences straddle zero; bounds are not clamped", () => {
    const d = pairedBootstrapDiffCI([0.9, 0.1, 0.8, 0.2, 0.7], [0.1, 0.9, 0.2, 0.8, 0.3]);
    expect(d.significant).toBe(false);
    expect(d.lo).toBeLessThan(0);
    expect(d.hi).toBeGreaterThan(0);
    const neg = pairedBootstrapDiffCI([0, 0, 0, 0], [1, 1, 1, 1]);
    expect(neg.diff).toBe(-1);
    expect(neg.hi).toBe(-1);
    expect(neg.significant).toBe(true);
  });

  test("deterministic; empty → zeros; misaligned input throws", () => {
    const a = [0.5, 0.7, 0.2, 0.9];
    const b = [0.4, 0.9, 0.1, 0.3];
    expect(pairedBootstrapDiffCI(a, b, { seed: 5 })).toEqual(
      pairedBootstrapDiffCI(a, b, { seed: 5 }),
    );
    expect(pairedBootstrapDiffCI([], [])).toEqual({ lo: 0, hi: 0, diff: 0, significant: false });
    expect(() => pairedBootstrapDiffCI([1], [1, 2])).toThrow();
  });
});
