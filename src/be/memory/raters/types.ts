/**
 * Memory rater interface — pluggable signal source for the Beta-Binomial
 * usefulness posteriors on agent_memory rows.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-1.md §2
 *
 * Each rater returns RatingEvent[] from `rate(ctx)`. The framework
 * (`applyRating` in ./store.ts) is the single chokepoint that:
 *   - validates signal ∈ [-1, +1] and weight ∈ [0, 1],
 *   - stamps `source = rater.name` (raters MUST NOT populate this — defence
 *     against rater spoofing),
 *   - applies the Beta posterior update atomically, and
 *   - writes the audit row to `memory_rating`.
 */

export interface MemoryRater {
  readonly name: string;
  rate(ctx: RatingContext): Promise<RatingEvent[]>;
}

export type RatingEvent = {
  memoryId: string;
  /** Raw signal in [-1, +1]. Positive = useful, negative = misleading. */
  signal: number;
  /** Confidence in [0, 1]. Clipped delta = max(0, ±signal) * weight. */
  weight: number;
  /**
   * Rater identity — populated by the framework, NOT by the rater itself.
   * Raters that write a non-empty `source` are rejected by `applyRating`.
   */
  source: string;
  /** Optional human-readable reason. Surfaced by LlmRater + ExplicitSelfRater. */
  reasoning?: string;
};

export type RatingContext = {
  taskId?: string;
  agentId: string;
  sessionId?: string;
  /** Memories that were retrieved during this task; raters score subsets of these. */
  retrievedMemoryIds: string[];
  /**
   * Server-side raters get session_logs content here; worker-side raters get
   * the LLM summary text or the explicit user input. Null when no evidence is
   * available (e.g. NoopRater).
   */
  evidence: string | null;
};
