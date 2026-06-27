import { describe, expect, test } from "bun:test";
import { bootstrapCI, bootstrapDiffCI, meanOrNull, wilsonInterval } from "./stats.ts";

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
