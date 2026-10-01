import type { AgentMemorySource } from "@/types";
import {
  ACCESS_BOOST_RECENCY_WINDOW_HOURS,
  accessBoostMaxMultiplier,
  DECISIONS_ROOT,
  PATH_WEIGHT,
  recencyDecayHalfLifeDays,
  SOURCE_QUALITY_MULTIPLIER,
  SUPERSEDED_DECISION_WEIGHT,
} from "./constants";
import { isKeyUnderRoot, tierSource } from "./key-paths";
import type { MemoryCandidate, RerankOptions } from "./types";

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Exponential decay based on age and memory source.
 * Source-aware: manual memories have no decay (Infinity half-life),
 * file_index = 180d, task_completion = 14d, session_summary = 7d.
 * A memory under /longterm decays like a manual one, whatever its source.
 */
export function recencyDecay(
  createdAt: string,
  now: Date,
  source?: AgentMemorySource,
  key?: string | null,
): number {
  const halfLife = recencyDecayHalfLifeDays(source && tierSource(source, key));
  if (!Number.isFinite(halfLife)) return 1.0;
  const ageDays = (now.getTime() - new Date(createdAt).getTime()) / MS_PER_DAY;
  if (ageDays <= 0) return 1.0;
  return 2 ** (-ageDays / halfLife);
}

/**
 * Boost for frequently/recently accessed memories.
 * Range: [1.0, ACCESS_BOOST_MAX_MULTIPLIER].
 */
export function accessBoost(accessedAt: string, accessCount: number, now: Date): number {
  if (accessCount <= 0) return 1.0;

  const hoursSinceAccess = (now.getTime() - new Date(accessedAt).getTime()) / MS_PER_HOUR;
  const recencyFactor = hoursSinceAccess <= ACCESS_BOOST_RECENCY_WINDOW_HOURS ? 1.0 : 0.5;
  const boost = 1 + Math.min(accessCount / 10, accessBoostMaxMultiplier() - 1) * recencyFactor;
  return boost;
}

/**
 * Source-quality multiplier. Manual memories get a 1.5× boost,
 * session summaries get 0.5×. Unknown sources default to 1.0.
 * A memory under /longterm is weighed as manual, whatever its source.
 */
export function sourceQuality(source: AgentMemorySource, key?: string | null): number {
  return SOURCE_QUALITY_MULTIPLIER[tierSource(source, key)] ?? 1.0;
}

/**
 * Path-weight multiplier from the logical path in `key`, by longest matching
 * root. A key under no weighted root (legacy auto keys, file paths, null)
 * weighs 1.0, so existing memories score as before. A `/longterm/decisions` doc tagged
 * `superseded` weighs SUPERSEDED_DECISION_WEIGHT instead of the root's weight.
 */
export function pathWeight(key: string | null | undefined, tags: readonly string[] = []): number {
  if (!key) return 1.0;
  let root: string | undefined;
  for (const candidate of Object.keys(PATH_WEIGHT)) {
    if (isKeyUnderRoot(key, candidate) && (!root || candidate.length > root.length)) {
      root = candidate;
    }
  }
  if (!root) return 1.0;
  if (root === DECISIONS_ROOT && tags.includes("superseded")) return SUPERSEDED_DECISION_WEIGHT;
  return PATH_WEIGHT[root] ?? 1.0;
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
 * Final score combining similarity, recency decay, access boost,
 * source quality, path weight, and Beta-Binomial usefulness.
 */
export function computeScore(candidate: MemoryCandidate, now: Date): number {
  const decay = candidate.recencyDecayApplied
    ? 1.0
    : recencyDecay(candidate.createdAt, now, candidate.source, candidate.key);
  return (
    candidate.similarity *
    decay *
    accessBoost(candidate.accessedAt, candidate.accessCount, now) *
    sourceQuality(candidate.source, candidate.key) *
    pathWeight(candidate.key, candidate.tags) *
    usefulness(candidate.alpha, candidate.beta)
  );
}

/**
 * Rerank candidates by combining similarity with recency, source quality,
 * and access signals. Returns the top `limit` candidates sorted by composite
 * score. Preserves raw similarity in `rawSimilarity` and sets `compositeScore`.
 *
 * A graph candidate's composite is capped at its parent's: the neighbour
 * carries its own access/source/usefulness boosts, and without the cap a few
 * boosted neighbours can push the direct hit that surfaced them out of the
 * result set. Ties go to the higher `rawSimilarity`, so the parent sorts first.
 */
export function rerank(candidates: MemoryCandidate[], options: RerankOptions): MemoryCandidate[] {
  const { limit, now = new Date() } = options;

  const uncapped = new Map<string, number>();
  for (const candidate of candidates) uncapped.set(candidate.id, computeScore(candidate, now));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const capped = new Map<string, number>();
  // Walks the parent chain (a parent can itself be a graph entry that replaced
  // an organic duplicate); `seen` guards against a link cycle.
  const cappedScore = (candidate: MemoryCandidate, seen: Set<string>): number => {
    const cached = capped.get(candidate.id);
    if (cached !== undefined) return cached;
    let score = uncapped.get(candidate.id)!;
    const parent = candidate.graphParentId ? byId.get(candidate.graphParentId) : undefined;
    if (parent && !seen.has(parent.id)) {
      seen.add(candidate.id);
      score = Math.min(score, cappedScore(parent, seen));
    }
    capped.set(candidate.id, score);
    return score;
  };

  const scored = candidates.map((candidate) => {
    const rawSimilarity = candidate.rawSimilarity ?? candidate.similarity;
    const compositeScore = cappedScore(candidate, new Set());
    return {
      ...candidate,
      rawSimilarity,
      compositeScore,
      similarity: compositeScore,
    };
  });

  scored.sort((a, b) => b.similarity - a.similarity || b.rawSimilarity - a.rawSimilarity);
  return scored.slice(0, limit);
}
