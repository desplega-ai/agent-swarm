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
import { getDb } from "@/be/db";

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

export function getUsefulnessStats(options: UsefulnessStatsOptions = {}): UsefulnessStats {
  const days = options.days ?? 30;
  const threshold = options.threshold ?? 0.6;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();

  // Volume — window rows, distinct memories, per-call groups, eventType split.
  // SUM(CASE …) instead of COUNT(*) FILTER for maximum SQLite compatibility.
  const volumeRow = db
    .prepare<
      {
        retrievals: number;
        distinctMemories: number;
        retrievalGroups: number;
        searchEvents: number | null;
        getEvents: number | null;
      },
      [string]
    >(
      `SELECT COUNT(*)                                                AS retrievals,
              COUNT(DISTINCT memoryId)                                AS distinctMemories,
              COUNT(DISTINCT retrievalId)                             AS retrievalGroups,
              SUM(CASE WHEN eventType = 'search' THEN 1 ELSE 0 END)   AS searchEvents,
              SUM(CASE WHEN eventType = 'get' THEN 1 ELSE 0 END)      AS getEvents
         FROM memory_retrieval
        WHERE retrievedAt > ?`,
    )
    .get(cutoff)!;

  // Per-arm breakdown — retrieval provenance plus "did this surfaced memory
  // get cited in the same task". EXISTS keeps multi-rating (task, memory)
  // pairs from inflating the count. Restricted to search events: memory-get
  // rows carry no retrievalSource and would otherwise pollute the NULL
  // ("legacy") arm. NULL eventType = pre-096 rows, kept (they were searches).
  const armRows = db
    .prepare<
      {
        retrievalSource: string | null;
        retrievals: number;
        distinctMemories: number;
        citedRetrievals: number | null;
      },
      [string]
    >(
      `SELECT mr.retrievalSource            AS retrievalSource,
              COUNT(*)                      AS retrievals,
              COUNT(DISTINCT mr.memoryId)   AS distinctMemories,
              SUM(CASE WHEN EXISTS (
                    SELECT 1
                      FROM memory_rating rt
                     WHERE rt.taskId = mr.taskId
                       AND rt.memoryId = mr.memoryId
                       AND rt.source = 'implicit-citation'
                       AND rt.signal > 0
                  ) THEN 1 ELSE 0 END)      AS citedRetrievals
         FROM memory_retrieval mr
        WHERE mr.retrievedAt > ?
          AND (mr.eventType IS NULL OR mr.eventType = 'search')
        GROUP BY mr.retrievalSource
        ORDER BY retrievals DESC`,
    )
    .all(cutoff);

  // Citation rate per memory-source — the reconstructed R4 §A.2 query.
  const sourceRows = db
    .prepare<
      {
        source: string;
        ratings: number;
        positive: number | null;
        avgSignal: number | null;
      },
      [string]
    >(
      `SELECT am.source                                       AS source,
              COUNT(*)                                        AS ratings,
              SUM(CASE WHEN mr.signal > 0 THEN 1 ELSE 0 END)  AS positive,
              AVG(mr.signal)                                  AS avgSignal
         FROM memory_rating mr
         JOIN agent_memory am ON am.id = mr.memoryId
        WHERE mr.source = 'implicit-citation'
          AND mr.createdAt > ?
        GROUP BY am.source
        ORDER BY ratings DESC`,
    )
    .all(cutoff);

  // Posterior movement — how far the Beta(1,1) priors have drifted.
  const posteriorRow = db
    .prepare<
      {
        totalMemories: number;
        movedFromPrior: number | null;
        avgPosteriorMean: number | null;
        avgPosteriorMeanMoved: number | null;
        aboveThreshold: number | null;
      },
      [number]
    >(
      `SELECT COUNT(*)                                                   AS totalMemories,
              SUM(CASE WHEN alpha <> 1.0 OR beta <> 1.0 THEN 1 ELSE 0 END) AS movedFromPrior,
              AVG(alpha / (alpha + beta))                                AS avgPosteriorMean,
              AVG(CASE WHEN alpha <> 1.0 OR beta <> 1.0
                       THEN alpha / (alpha + beta) END)                  AS avgPosteriorMeanMoved,
              SUM(CASE WHEN alpha / (alpha + beta) > ? THEN 1 ELSE 0 END) AS aboveThreshold
         FROM agent_memory`,
    )
    .get(threshold)!;

  // Sanity — all-time totals, unwindowed: "is anything flowing at all".
  const totalRetrievalRows = db
    .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_retrieval")
    .get()!.n;
  const ratingsBySource = db
    .prepare<{ source: string; count: number }, []>(
      "SELECT source, COUNT(*) AS count FROM memory_rating GROUP BY source ORDER BY count DESC",
    )
    .all();
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
