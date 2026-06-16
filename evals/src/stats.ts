/**
 * stats — pure statistical helpers for the convergent reliability metric.
 *
 * Two estimators back the matrix headline (Plan A, Phase 3):
 *  - `bootstrapCI`  — percentile confidence interval over a cell's per-attempt
 *    dimension scores. This is the DISCRIMINATION headline: it tightens ~1/√n,
 *    so attempt-count `n` becomes a confidence dial instead of a "best@n" luck
 *    dial. The resample is driven by a SEEDED PRNG (mulberry32) so identical
 *    inputs always produce identical bounds — reproducible across runs/machines.
 *  - `wilsonInterval` — the Wilson score interval for a binomial proportion
 *    (pass-rate). Interpretable companion: "k of n attempts passed, true rate is
 *    plausibly in [lo, hi]." Well-behaved at the extremes (0/n, n/n) where the
 *    naive normal interval collapses.
 *
 * Both functions are pure and side-effect free. No `Math.random` — determinism
 * is a hard requirement (the CI bounds are persisted/rendered and compared).
 */

/** Inclusive [lo, hi] bound pair, clamped to [0, 1] for score/proportion use. */
export interface Interval {
  lo: number;
  hi: number;
}

/** Bootstrap percentile CI, tagged with its method for the API/UI surface. */
export interface BootstrapInterval extends Interval {
  method: "bootstrap";
}

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit seeded PRNG. Deterministic
 * for a given seed; returns a float in [0, 1). Used so bootstrap resampling is
 * reproducible. (Public-domain algorithm by Tommy Ettinger / bryc.)
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolated percentile (`p` in [0, 1]) over a pre-sorted array. */
function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export interface BootstrapOptions {
  /** Resample iterations (higher = smoother bounds). Default 2000. */
  iters?: number;
  /** Two-sided alpha; CI covers the middle (1 - alpha). Default 0.05 → 95%. */
  alpha?: number;
  /** PRNG seed — makes the CI reproducible. Default 0xC0FFEE. */
  seed?: number;
}

/**
 * Bootstrap percentile confidence interval for the MEAN of `scores`.
 *
 * Resamples `scores` with replacement `iters` times, takes each resample's mean,
 * and returns the [alpha/2, 1 - alpha/2] percentiles of that distribution. The
 * interval narrows as `n` grows (the whole point — it's the discrimination
 * confidence band). Bounds are clamped to [0, 1] since dimension scores are.
 *
 * Edge cases (never throws, never NaN):
 *  - n === 0 → { lo: 0, hi: 0 } (no data; caller should treat the mean as null)
 *  - n === 1 → degenerate { lo: x, hi: x } (one point can't bound itself)
 *  - all-equal scores → { lo: x, hi: x }
 */
export function bootstrapCI(scores: number[], opts: BootstrapOptions = {}): BootstrapInterval {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 0xc0ffee;
  const n = scores.length;
  if (n === 0) return { lo: 0, hi: 0, method: "bootstrap" };
  if (n === 1) {
    const x = clamp01(scores[0]!);
    return { lo: x, hi: x, method: "bootstrap" };
  }
  const rng = mulberry32(seed);
  const means: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) {
      acc += scores[Math.floor(rng() * n)]!;
    }
    means[i] = acc / n;
  }
  means.sort((a, b) => a - b);
  const lo = clamp01(percentileSorted(means, alpha / 2));
  const hi = clamp01(percentileSorted(means, 1 - alpha / 2));
  return { lo, hi, method: "bootstrap" };
}

/**
 * Wilson score interval for a binomial proportion `passed / total`.
 *
 * `z` is the standard-normal quantile for the desired two-sided coverage
 * (default 1.96 → 95%). Unlike the naive normal interval, Wilson stays inside
 * [0, 1] and gives sensible bounds at 0/n and n/n.
 *
 * Edge case: total === 0 → { lo: 0, hi: 0 } (no observations; caller decides how
 * to render "unknown").
 */
export function wilsonInterval(passed: number, total: number, z = 1.96): Interval {
  if (total === 0) return { lo: 0, hi: 0 };
  const phat = passed / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total))) / denom;
  return { lo: clamp01(center - margin), hi: clamp01(center + margin) };
}

/** Convenience: mean of a non-empty score array (null when empty). */
export function meanOrNull(scores: number[]): number | null {
  return scores.length ? mean(scores) : null;
}

/** A difference-of-means CI plus whether it excludes 0 (i.e. the gap is significant). */
export interface DiffInterval extends Interval {
  /** mean(a) - mean(b). */
  diff: number;
  /** true when the whole CI is on one side of 0 (gap is significant at this n). */
  significant: boolean;
}

/**
 * Two-sample bootstrap CI for the difference of means `mean(a) - mean(b)`.
 *
 * Resamples each group independently with replacement (seeded → reproducible),
 * forms the difference of resampled means, and returns the percentile CI. Used by
 * the calibration report to decide whether the frontier−budget gap is
 * SIGNIFICANT at the run's `n` (CI excludes 0), not just positive. Bounds are NOT
 * clamped to [0, 1] — a difference can be negative.
 *
 * Edge: either group empty → diff 0, CI [0, 0], not significant.
 */
export function bootstrapDiffCI(
  a: number[],
  b: number[],
  opts: BootstrapOptions = {},
): DiffInterval {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 0xc0ffee;
  if (a.length === 0 || b.length === 0) {
    return { lo: 0, hi: 0, diff: 0, significant: false };
  }
  const diff = mean(a) - mean(b);
  // Two independent streams from one seed so the whole run is reproducible.
  const rngA = mulberry32(seed);
  const rngB = mulberry32(seed ^ 0x9e3779b9);
  const diffs: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let accA = 0;
    for (let j = 0; j < a.length; j++) accA += a[Math.floor(rngA() * a.length)]!;
    let accB = 0;
    for (let j = 0; j < b.length; j++) accB += b[Math.floor(rngB() * b.length)]!;
    diffs[i] = accA / a.length - accB / b.length;
  }
  diffs.sort((x, y) => x - y);
  const lo = percentileSorted(diffs, alpha / 2);
  const hi = percentileSorted(diffs, 1 - alpha / 2);
  return { lo, hi, diff, significant: lo > 0 || hi < 0 };
}
