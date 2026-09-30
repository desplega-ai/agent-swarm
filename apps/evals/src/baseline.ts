/**
 * Single-agent baselines for swarm scenarios (swarm-evals plan v2, Q6).
 *
 * A swarm scenario (lead + workers) can ship a `<id>-solo` variant: the same
 * brief and answer key handed to ONE worker with no lead, at the same timeout
 * and budgets. Running both answers "how much does the swarm add?", which a
 * published swarm number needs.
 *
 * The two rubrics differ on purpose: the swarm rubric also grades orchestration
 * (delegation, recovery), which a lone worker cannot do. So the score delta is
 * computed on the SHARED dimensions only: the solo rubric's dimensions, which
 * `validateBaselinePairs` (src/registry.ts) guarantees exist in the swarm rubric
 * at the same weight. The runner persists one judgment row per dimension, so the
 * shared score is a re-weighted mean over those rows.
 */

import { normalizeOutcome } from "./normalize-outcome.ts";
import { bootstrapDiffCI, type DiffInterval, meanOrNull } from "./stats.ts";
import { type AttemptRow, type JudgmentRow, type Scenario, totalTokenCount } from "./types.ts";

export const SOLO_SUFFIX = "-solo";

/** `fanout-research` -> `fanout-research-solo`. */
export function soloVariantId(swarmId: string): string {
  return `${swarmId}${SOLO_SUFFIX}`;
}

export interface BaselinePair {
  swarmId: string;
  soloId: string;
  /** Dimensions both rubrics share (the solo rubric's, minus efficiency), the basis of the score delta. */
  dimensions: string[];
}

/**
 * Every registered swarm/solo pair, in registry order of the solo variant. The
 * `efficiency` dimension is left out of the score delta: cost and time are
 * reported on their own (token multiple, Δagent time), so counting them in
 * Δscore too would double-count.
 */
export function baselinePairs(all: Scenario[]): BaselinePair[] {
  return all
    .filter((s): s is Scenario & { baselineOf: string } => s.baselineOf !== undefined)
    .map((solo) => ({
      swarmId: solo.baselineOf,
      soloId: solo.id,
      dimensions: normalizeOutcome(solo.outcome)
        .dimensions.map((d) => d.name)
        .filter((name) => name !== "efficiency"),
    }));
}

/**
 * Weighted mean of the judgment rows whose dimension is in `dimensions`. Null
 * when none is present (an unscored attempt). A dimension the runner dropped
 * (efficiency with no metric) has no row and drops out here too, exactly as it
 * does from the attempt score.
 */
export function sharedDimensionScore(
  judgments: Pick<JudgmentRow, "dimension" | "weight" | "score">[],
  dimensions: readonly string[],
): number | null {
  const wanted = new Set(dimensions);
  let weighted = 0;
  let totalWeight = 0;
  for (const j of judgments) {
    if (j.dimension === null || !wanted.has(j.dimension)) continue;
    if (j.weight === null || j.score === null) continue;
    weighted += j.weight * j.score;
    totalWeight += j.weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

export interface BaselineAttempt {
  attempt: Pick<AttemptRow, "status" | "tokens" | "timings">;
  judgments: Pick<JudgmentRow, "dimension" | "weight" | "score">[];
}

export interface BaselineSide {
  /** Scored attempts (passed or failed) that carry a shared-dimension score. */
  n: number;
  meanScore: number | null;
  /** Mean total tokens across every roster member (attempt-level token totals). */
  meanTokens: number | null;
  /** Mean agent time (timings.tasksMs, sandbox boot and seeding excluded). */
  meanAgentMs: number | null;
}

export interface SwarmSoloComparison {
  swarmId: string;
  soloId: string;
  configId: string;
  swarm: BaselineSide;
  solo: BaselineSide;
  /** swarm minus solo on the shared dimensions, with a bootstrap CI; null when a side has no score. */
  deltaScore: DiffInterval | null;
  /** swarm tokens / solo tokens; null when either side has no token data. */
  tokenMultiple: number | null;
  /** swarm agent time minus solo agent time, ms; null when either side has no timings. */
  deltaAgentMs: number | null;
}

function scored(attempts: BaselineAttempt[]): BaselineAttempt[] {
  return attempts.filter((a) => a.attempt.status === "passed" || a.attempt.status === "failed");
}

function side(
  attempts: BaselineAttempt[],
  dimensions: readonly string[],
): { stats: BaselineSide; scores: number[] } {
  const scores: number[] = [];
  const tokens: number[] = [];
  const agentMs: number[] = [];
  for (const a of scored(attempts)) {
    const score = sharedDimensionScore(a.judgments, dimensions);
    if (score === null) continue;
    scores.push(score);
    if (a.attempt.tokens && totalTokenCount(a.attempt.tokens) > 0) {
      tokens.push(totalTokenCount(a.attempt.tokens));
    }
    const ms = a.attempt.timings?.tasksMs;
    if (typeof ms === "number") agentMs.push(ms);
  }
  return {
    scores,
    stats: {
      n: scores.length,
      meanScore: meanOrNull(scores),
      meanTokens: meanOrNull(tokens),
      meanAgentMs: meanOrNull(agentMs),
    },
  };
}

/** Swarm vs solo for one config: Δscore on shared dimensions, token multiple, Δagent time. */
export function compareSwarmSolo(
  pair: BaselinePair,
  configId: string,
  swarmAttempts: BaselineAttempt[],
  soloAttempts: BaselineAttempt[],
): SwarmSoloComparison {
  const swarm = side(swarmAttempts, pair.dimensions);
  const solo = side(soloAttempts, pair.dimensions);
  const tokenMultiple =
    swarm.stats.meanTokens !== null && solo.stats.meanTokens !== null && solo.stats.meanTokens > 0
      ? swarm.stats.meanTokens / solo.stats.meanTokens
      : null;
  const deltaAgentMs =
    swarm.stats.meanAgentMs !== null && solo.stats.meanAgentMs !== null
      ? swarm.stats.meanAgentMs - solo.stats.meanAgentMs
      : null;
  return {
    swarmId: pair.swarmId,
    soloId: pair.soloId,
    configId,
    swarm: swarm.stats,
    solo: solo.stats,
    deltaScore:
      swarm.scores.length > 0 && solo.scores.length > 0
        ? bootstrapDiffCI(swarm.scores, solo.scores)
        : null,
    tokenMultiple,
    deltaAgentMs,
  };
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** One `show` line: `claude-opus-5.5: Δscore +0.12 [-0.05, +0.30] · tokens ×2.8 · Δagent time +95s (n 3/3)`. */
export function formatComparison(c: SwarmSoloComparison): string {
  const delta = c.deltaScore
    ? `Δscore ${signed(c.deltaScore.diff, 2)} [${signed(c.deltaScore.lo, 2)}, ${signed(c.deltaScore.hi, 2)}]${c.deltaScore.significant ? " *" : ""}`
    : "Δscore n/a";
  const tokens = c.tokenMultiple !== null ? `tokens ×${c.tokenMultiple.toFixed(1)}` : "tokens n/a";
  const time =
    c.deltaAgentMs !== null
      ? `Δagent time ${signed(Math.round(c.deltaAgentMs / 1000), 0)}s`
      : "Δagent time n/a";
  return `${c.configId}: ${delta} · ${tokens} · ${time} (n ${c.swarm.n}/${c.solo.n})`;
}
