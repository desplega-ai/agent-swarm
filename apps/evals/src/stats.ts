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

/**
 * Unbiased pass^k estimator for one cell: the probability that ALL of `k`
 * attempts drawn without replacement from `total` observed attempts pass, given
 * `passed` of them did. C(passed, k) / C(total, k), computed as a product so it
 * stays finite for any n.
 *
 * Null when `k` is not a positive integer, `passed` is out of range, or the cell
 * has fewer than `k` attempts (the estimator is undefined there, not zero).
 * Sanity: k = 1 is the plain pass rate; passed < k is 0; passed = total is 1.
 */
export function passPowK(passed: number, total: number, k: number): number | null {
  if (!Number.isInteger(k) || k < 1 || passed < 0 || passed > total || total < k) return null;
  if (passed < k) return 0;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (passed - i) / (total - i);
  return p;
}

/**
 * Unbiased pass@k estimator: the probability that AT LEAST ONE of `k` attempts
 * drawn without replacement from `total` passes. 1 - C(total - passed, k) / C(total, k).
 * Null under the same conditions as {@link passPowK}.
 */
export function passAtK(passed: number, total: number, k: number): number | null {
  if (!Number.isInteger(k) || k < 1 || passed < 0 || passed > total || total < k) return null;
  const failed = total - passed;
  if (failed < k) return 1;
  let allFail = 1;
  for (let i = 0; i < k; i++) allFail *= (failed - i) / (total - i);
  return 1 - allFail;
}

/** Mean of the non-empty strata's means: each scenario counts once, however many attempts it has. */
function macroMean(strata: number[][]): number | null {
  let sum = 0;
  let n = 0;
  for (const s of strata) {
    if (s.length === 0) continue;
    sum += mean(s);
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/** One bootstrap replicate of {@link macroMean}: resample each stratum with replacement. */
function resampledMacroMean(strata: number[][], rng: () => number): number | null {
  let sum = 0;
  let n = 0;
  for (const s of strata) {
    const m = s.length;
    if (m === 0) continue;
    let acc = 0;
    for (let j = 0; j < m; j++) acc += s[Math.floor(rng() * m)]!;
    sum += acc / m;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

export interface StratifiedInterval extends BootstrapInterval {
  /** Macro mean over the non-empty strata; null when there are none. */
  mean: number | null;
}

/**
 * Bootstrap CI for a suite score: the mean of per-scenario means.
 *
 * `strata` holds one array of attempt scores per scenario. The suite's scenarios
 * are fixed, so only the attempts inside each scenario are resampled (stratified
 * bootstrap); the CI then reflects attempt-to-attempt noise and not which
 * scenarios happened to be chosen. Each scenario counts once, so a config with
 * extra attempts on one scenario is not pulled toward it.
 *
 * Seeded like {@link bootstrapCI}. No strata → mean null, CI [0, 0]. Strata of one
 * attempt each cannot vary, so the CI collapses to the mean (callers flag low n).
 */
export function stratifiedBootstrapCI(
  strata: number[][],
  opts: BootstrapOptions = {},
): StratifiedInterval {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const point = macroMean(strata);
  if (point === null) return { mean: null, lo: 0, hi: 0, method: "bootstrap" };
  const rng = mulberry32(opts.seed ?? 0xc0ffee);
  const means: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) means[i] = resampledMacroMean(strata, rng) ?? point;
  means.sort((a, b) => a - b);
  return {
    mean: point,
    lo: clamp01(percentileSorted(means, alpha / 2)),
    hi: clamp01(percentileSorted(means, 1 - alpha / 2)),
    method: "bootstrap",
  };
}

/** Bootstrap spread of one group's rank; 1 is best. */
export interface RankSpread {
  /** Lower percentile of the rank, rounded down to a whole rank. */
  lo: number;
  /** Upper percentile of the rank, rounded up to a whole rank. */
  hi: number;
  /** Median rank across replicates (ties share the average rank, so it can be x.5). */
  median: number;
}

/**
 * How stable each group's rank is. `groups[g]` is group g's strata (see
 * {@link stratifiedBootstrapCI}). Every replicate resamples every group and ranks
 * the groups by macro mean (highest = rank 1, tied groups share the average of
 * the ranks they span), so a leaderboard can print "rank 2, could be 1 to 4".
 *
 * Groups with no data get `null`. Seeded, so the same input gives the same spread.
 */
export function bootstrapRankSpread(
  groups: number[][][],
  opts: BootstrapOptions = {},
): (RankSpread | null)[] {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const live = groups.map((g, i) => (macroMean(g) === null ? -1 : i)).filter((i) => i >= 0);
  const out: (RankSpread | null)[] = groups.map(() => null);
  if (live.length === 0) return out;
  const rng = mulberry32(opts.seed ?? 0xc0ffee);
  const ranks = live.map(() => new Array<number>(iters));
  const draw: number[] = new Array(live.length);
  for (let it = 0; it < iters; it++) {
    for (let li = 0; li < live.length; li++) {
      draw[li] = resampledMacroMean(groups[live[li]!]!, rng) ?? 0;
    }
    for (let li = 0; li < live.length; li++) {
      let greater = 0;
      let equal = 0;
      for (let lj = 0; lj < live.length; lj++) {
        if (lj === li) continue;
        const d = draw[lj]! - draw[li]!;
        if (d > 1e-12) greater += 1;
        else if (d >= -1e-12) equal += 1;
      }
      ranks[li]![it] = 1 + greater + equal / 2;
    }
  }
  for (let li = 0; li < live.length; li++) {
    const sorted = ranks[li]!.sort((a, b) => a - b);
    out[live[li]!] = {
      lo: Math.floor(percentileSorted(sorted, alpha / 2)),
      hi: Math.ceil(percentileSorted(sorted, 1 - alpha / 2)),
      median: percentileSorted(sorted, 0.5),
    };
  }
  return out;
}

/**
 * Paired bootstrap CI for the mean of `a[i] - b[i]`, resampling the PAIRS.
 *
 * Unlike {@link bootstrapDiffCI}, which resamples the two groups independently,
 * this keeps each pair together, so a shared difficulty (the same scenario is
 * hard for both configs) cancels instead of widening the interval. Pass one pair
 * per scenario to resample scenarios, not attempts. `a` and `b` must be the same
 * length and index-aligned. Bounds are not clamped: a difference can be negative.
 *
 * Edge: empty input → diff 0, CI [0, 0], not significant.
 */
export function pairedBootstrapDiffCI(
  a: number[],
  b: number[],
  opts: BootstrapOptions = {},
): DiffInterval {
  if (a.length !== b.length) throw new Error("pairedBootstrapDiffCI: a and b must be aligned");
  const n = a.length;
  if (n === 0) return { lo: 0, hi: 0, diff: 0, significant: false };
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const d = a.map((x, i) => x - b[i]!);
  const diff = mean(d);
  const rng = mulberry32(opts.seed ?? 0xc0ffee);
  const diffs: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += d[Math.floor(rng() * n)]!;
    diffs[i] = acc / n;
  }
  diffs.sort((x, y) => x - y);
  const lo = percentileSorted(diffs, alpha / 2);
  const hi = percentileSorted(diffs, 1 - alpha / 2);
  return { lo, hi, diff, significant: lo > 0 || hi < 0 };
}
