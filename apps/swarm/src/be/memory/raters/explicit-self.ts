import type { MemoryRater, RatingEvent } from "./types";

/**
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-5.md §3
 *
 * Explicit-self rater — registry sentinel only. Never auto-fires from
 * `applyRating`. Its `RatingEvent`s arrive exclusively through the worker-side
 * `memory_rate` MCP tool, which POSTs to `/api/memory/rate` with
 * `source: "explicit-self"`.
 *
 * The class exists so `MEMORY_RATERS=explicit-self` can register the name —
 * which (per step-5.md §5) unlocks the conditional system-prompt hint that
 * teaches the agent to call `memory_rate`. Stays out of `SERVER_RATERS` so
 * the store-progress hook never invokes it.
 */
export class ExplicitSelfRatingRater implements MemoryRater {
  readonly name = "explicit-self";

  async rate(): Promise<RatingEvent[]> {
    return [];
  }
}
