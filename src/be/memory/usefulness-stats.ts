/**
 * Windowed usefulness analytics over the memory measurement tables.
 *
 * Answers "is memory useful, per source and per retrieval arm" by reading the
 * plumbing that Phases 1–2 of the memory-enhancements track already write:
 *   - `memory_retrieval` — one row per memory surfaced to a task
 *     (051 base + 096 contextKey/intent/eventType + 097 retrievalId/rank +
 *     100 retrievalSource).
 *   - `memory_rating`    — append-only RatingEvent audit (051 + 096
 *     contextKey); `source='implicit-citation'` rows are the citation signal.
 *   - `agent_memory.alpha/beta` — Beta-Binomial usefulness posteriors (051).
 *
 * Served by `GET /api/memory/usefulness` (src/http/memory.ts) as a sibling of
 * the cheap `/api/memory/health` probe. Server-side only (owns SQL via
 * `getDb()`); plan: thoughts/taras/plans/2026-07-02-memory-retrieval-v2-graph-and-measurement.md
 * Phase 1.
 */
import { getStorage } from "@/be/storage";

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface UsefulnessVolume {
  /** memory_retrieval rows inside the window. */
  retrievals: number;
  /** Distinct memories surfaced inside the window. */
  distinctMemories: number;
  /** Distinct retrievalId groups (one per search/get call; pre-097 rows have NULL and are not counted). */
  retrievalGroups: number;
  /** Window rows split by eventType (CHECK: 'search' | 'get'). */
  byEventType: { search: number; get: number };
}

export interface UsefulnessArmStats {
  /** memory_retrieval.retrievalSource — 'vec' | 'fts' | 'hybrid' | 'fallback' ('graph' after DES-639a); NULL = pre-100 legacy rows. */
  retrievalSource: string | null;
  retrievals: number;
  distinctMemories: number;
  /** Window rows whose (taskId, memoryId) got a positive implicit-citation rating. */
  citedRetrievals: number;
  /** citedRetrievals / retrievals. */
  citationRate: number;
}

export interface UsefulnessSourceCitation {
  /** agent_memory.source — 'manual' | 'file_index' | 'session_summary' | 'task_completion'. */
  source: string;
  /** implicit-citation rating rows inside the window. */
  ratings: number;
  /** Ratings with signal > 0 (memory was cited in task evidence). */
  positive: number;
  /** positive / ratings — a true rate in [0, 1] (implicit-citation signals are ±1). */
  citationRate: number;
  /** AVG(signal) over the window's implicit-citation ratings — in [-1, 1]. */
  avgSignal: number;
}

export interface UsefulnessPosteriorStats {
  totalMemories: number;
  /** Memories whose posterior moved off the Beta(1,1) prior. */
  movedFromPrior: number;
  /** AVG(alpha / (alpha + beta)) across all memories; null when the store is empty. */
  avgPosteriorMean: number | null;
  /** Same average restricted to moved memories; null when none moved. */
  avgPosteriorMeanMoved: number | null;
  /** Memories with posterior mean above `threshold`. */
  aboveThreshold: number;
}

export interface UsefulnessSanity {
  /** All-time memory_retrieval row count — "is anything flowing". */
  totalRetrievalRows: number;
  /** All-time memory_rating row count. */
  totalRatingRows: number;
  /** All-time memory_rating rows grouped by rater source. */
  ratingsBySource: { source: string; count: number }[];
}

export interface UsefulnessStats {
  windowDays: number;
  threshold: number;
  /** ISO cutoff — rows strictly newer than this are inside the window. */
  cutoff: string;
  volume: UsefulnessVolume;
  byArm: UsefulnessArmStats[];
  citationBySource: UsefulnessSourceCitation[];
  posterior: UsefulnessPosteriorStats;
  sanity: UsefulnessSanity;
}

export interface UsefulnessStatsOptions {
  /** Window size in days (default 30). */
  days?: number;
  /** Posterior-mean threshold for the aboveThreshold count (default 0.6). */
  threshold?: number;
}

// ─── Query ───────────────────────────────────────────────────────────────────

export async function getUsefulnessStats(
  options: UsefulnessStatsOptions = {},
): Promise<UsefulnessStats> {
  const days = options.days ?? 30;
  const threshold = options.threshold ?? 0.6;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const {
    volume: volumeRow,
    arms: armRows,
    sources: sourceRows,
    posterior: posteriorRow,
    totalRetrievalRows,
    ratingsBySource,
  } = await getStorage().repos.memory.getUsefulnessRows(cutoff, threshold);
  const totalRatingRows = ratingsBySource.reduce((sum, row) => sum + row.count, 0);

  return {
    windowDays: days,
    threshold,
    cutoff,
    volume: {
      retrievals: volumeRow.retrievals,
      distinctMemories: volumeRow.distinctMemories,
      retrievalGroups: volumeRow.retrievalGroups,
      byEventType: {
        search: volumeRow.searchEvents ?? 0,
        get: volumeRow.getEvents ?? 0,
      },
    },
    byArm: armRows.map((row) => ({
      retrievalSource: row.retrievalSource,
      retrievals: row.retrievals,
      distinctMemories: row.distinctMemories,
      citedRetrievals: row.citedRetrievals ?? 0,
      citationRate: row.retrievals > 0 ? (row.citedRetrievals ?? 0) / row.retrievals : 0,
    })),
    citationBySource: sourceRows.map((row) => ({
      source: row.source,
      ratings: row.ratings,
      positive: row.positive ?? 0,
      citationRate: row.ratings > 0 ? (row.positive ?? 0) / row.ratings : 0,
      avgSignal: row.avgSignal ?? 0,
    })),
    posterior: {
      totalMemories: posteriorRow.totalMemories,
      movedFromPrior: posteriorRow.movedFromPrior ?? 0,
      avgPosteriorMean: posteriorRow.avgPosteriorMean,
      avgPosteriorMeanMoved: posteriorRow.avgPosteriorMeanMoved,
      aboveThreshold: posteriorRow.aboveThreshold ?? 0,
    },
    sanity: {
      totalRetrievalRows,
      totalRatingRows,
      ratingsBySource,
    },
  };
}
