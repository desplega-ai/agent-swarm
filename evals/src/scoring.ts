/**
 * Scoring constants + helpers shared by the registry, the v1→v2 outcome
 * normalizer, and the runner's weighted aggregation (v8.0 OutcomeSpec v2).
 *
 * Pure, no I/O. The runner does the side-effecting parts (running checks/judges,
 * persisting judgment rows); these helpers only do the arithmetic so the
 * aggregation math is directly unit-testable.
 */

/**
 * Default minimum aggregate score in [0,1] for an attempt to count as a pass
 * (v8.0). Gates the WEIGHTED AGGREGATE — `passed = allGatesPass && score >=
 * passThreshold` — NOT each judge individually. Single source of truth: it
 * replaces the previously-inlined `?? 0.7` at both the registry and runner
 * sites. Do not reintroduce a literal default elsewhere.
 */
export const DEFAULT_PASS_THRESHOLD = 0.75;

/**
 * Decay factor N for the deterministic efficiency dimension (v8.0 §5). An
 * attempt scores full efficiency credit (1.0) when its observed cost/time is at
 * or under budget, decaying LINEARLY to 0 at N× budget. N = 3 means an attempt
 * that costs (or takes) 3× the budget scores 0; anything beyond clamps at 0.
 */
export const EFFICIENCY_DECAY_FACTOR = 3;

/**
 * Deterministic efficiency sub-score in [0,1] for one observed metric vs its
 * budget (v8.0 §5). 1.0 at `observed ≤ budget`, then linear decay to 0 at
 * `observed = N·budget` (N = {@link EFFICIENCY_DECAY_FACTOR}); clamped to [0,1]
 * beyond N× budget.
 *
 *   score = clamp(1 - max(0, observed - budget) / ((N-1)·budget), 0, 1)
 *
 * The caller (runner §5) decides what `observed`/`budget` are (cost in USD or
 * time in ms) and, when BOTH cost and time budgets are set, takes the MIN of the
 * two sub-scores (worst-case discipline). A non-positive budget is rejected at
 * scenario-validation time; defensively, a `budget ≤ 0` here yields 1.0 when
 * `observed ≤ 0` else 0 (no divide-by-zero).
 */
export function efficiencyScore(observed: number, budget: number): number {
  if (!(budget > 0)) return observed <= 0 ? 1 : 0;
  const overage = Math.max(0, observed - budget);
  const score = 1 - overage / ((EFFICIENCY_DECAY_FACTOR - 1) * budget);
  return Math.min(1, Math.max(0, score));
}

/** One graded check feeding a dimension: its 0-1 value and per-check weight. */
export interface WeightedValue {
  /** 0-1 graded value (a check's `score ?? (pass ? 1 : 0)`). */
  value: number;
  /** Per-check weight (default 1); must be ≥ 0. */
  weight: number;
}

/**
 * Weighted mean of a dimension's member graded-check values
 * (`Σ wᵢ·valueᵢ / Σ wᵢ`). Returns 0 when there are no members or the total
 * weight is 0 (an empty/degenerate dimension contributes nothing, not a crash).
 */
export function dimensionScoreFromChecks(values: WeightedValue[]): number {
  const totalWeight = values.reduce((s, v) => s + v.weight, 0);
  if (totalWeight <= 0) return 0;
  return values.reduce((s, v) => s + v.weight * v.value, 0) / totalWeight;
}

/** One scored dimension contributing to the attempt aggregate. */
export interface ScoredDimension {
  weight: number;
  subScore: number;
}

/**
 * Weighted aggregate over dimensions: `Σ wᵢ·dimᵢ / Σ wᵢ`. Returns `null` when
 * the total weight is 0 (NO dimensions, or all weights 0) — the caller (runner)
 * treats that as the legacy gates-only path (`score = allGatesPass ? 1 : 0`).
 *
 * Re-normalization (e.g. an unpriced efficiency dimension skipping) is achieved
 * by simply omitting that dimension from `dims`: the divisor is the Σ of the
 * REMAINING weights, never the authored total.
 */
export function aggregateScore(dims: ScoredDimension[]): number | null {
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  if (totalWeight <= 0) return null;
  return dims.reduce((s, d) => s + d.weight * d.subScore, 0) / totalWeight;
}

/**
 * Compose the final attempt verdict from gates + scored dimensions (v8.0 §3.4).
 * The score is ALWAYS computed and reported — a failing gate forces
 * `passed = false` but never zeroes/skips the score (anti-gaming: a config
 * can't win by clearing only the cheap gate). When there are no dimensions
 * (legacy gates-only spec, `aggregateScore → null`), the score is the binary
 * gate verdict (`allGatesPass ? 1 : 0`). `passed = allGatesPass && score >=
 * passThreshold` — the threshold gates the WEIGHTED AGGREGATE, not each judge.
 */
export function finalizeScore(opts: {
  allGatesPass: boolean;
  dimensions: ScoredDimension[];
  passThreshold: number;
}): { score: number; passed: boolean } {
  const aggregate = aggregateScore(opts.dimensions);
  const score = aggregate ?? (opts.allGatesPass ? 1 : 0);
  return { score, passed: opts.allGatesPass && score >= opts.passThreshold };
}
