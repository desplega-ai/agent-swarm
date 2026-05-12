import {
  ACCESS_BOOST_MAX_MULTIPLIER,
  ACCESS_BOOST_RECENCY_WINDOW_HOURS,
  RECENCY_DECAY_HALF_LIFE_DAYS,
} from "./constants";
import type { MemoryCandidate, RerankOptions } from "./types";

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Exponential decay based on age. A memory at exactly HALF_LIFE_DAYS old
 * gets multiplied by 0.5. Fresh memories get ~1.0.
 */
export function recencyDecay(createdAt: string, now: Date): number {
  const ageDays = (now.getTime() - new Date(createdAt).getTime()) / MS_PER_DAY;
  if (ageDays <= 0) return 1.0;
  return 2 ** (-ageDays / RECENCY_DECAY_HALF_LIFE_DAYS);
}

/**
 * Boost for frequently/recently accessed memories.
 * Range: [1.0, ACCESS_BOOST_MAX_MULTIPLIER].
 */
export function accessBoost(accessedAt: string, accessCount: number, now: Date): number {
  if (accessCount <= 0) return 1.0;

  const hoursSinceAccess = (now.getTime() - new Date(accessedAt).getTime()) / MS_PER_HOUR;
  const recencyFactor = hoursSinceAccess <= ACCESS_BOOST_RECENCY_WINDOW_HOURS ? 1.0 : 0.5;
  const boost = 1 + Math.min(accessCount / 10, ACCESS_BOOST_MAX_MULTIPLIER - 1) * recencyFactor;
  return boost;
}

/**
 * Beta-Binomial usefulness factor for reranking.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-1.md §5
 *
 * At Beta(1,1) (default prior) returns 1.0 exactly — strict no-op vs.
 * pre-rater behaviour. Proven memories climb up to 2.0. Floored at the value
 * of MEMORY_DEMOTION_FLOOR (default 1.0 = no demotion) — the default preserves
 * brainstorm intent (memories are demoted toward the floor but never deleted
 * on the reranker path) and is configurable per deployment.
 */
function readDemotionFloor(): number {
  const raw = process.env.MEMORY_DEMOTION_FLOOR;
  const n = raw == null || raw === "" ? 1.0 : Number(raw);
  return Number.isFinite(n) ? n : 1.0;
}

export function usefulness(alpha: number, beta: number): number {
  const denom = alpha + beta;
  if (denom <= 0) return 1.0;
  const mean = alpha / denom;
  return Math.max(readDemotionFloor(), Math.min(2.0, 2 * mean));
}

/**
 * Final score combining similarity, recency decay, access boost, and
 * Beta-Binomial usefulness. With default Beta(1,1) and default
 * MEMORY_DEMOTION_FLOOR=1.0, the usefulness factor is exactly 1.0 and this
 * computation matches the pre-rater behaviour byte-for-byte.
 *
 * v2: optional edge-aware boost — see thoughts/taras/plans/2026-05-05-memory-rater-v1.5/root.md
 */
export function computeScore(candidate: MemoryCandidate, now: Date): number {
  return (
    candidate.similarity *
    recencyDecay(candidate.createdAt, now) *
    accessBoost(candidate.accessedAt, candidate.accessCount, now) *
    usefulness(candidate.alpha, candidate.beta)
  );
}

/**
 * Rerank candidates by combining similarity with recency and access signals.
 * Returns the top `limit` candidates sorted by final score.
 */
export function rerank(candidates: MemoryCandidate[], options: RerankOptions): MemoryCandidate[] {
  const { limit, now = new Date() } = options;

  const scored = candidates.map((candidate) => ({
    ...candidate,
    similarity: computeScore(candidate, now),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}
