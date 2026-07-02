import type { MemoryRater, RatingContext, RatingEvent } from "./types";

/**
 * Implicit-citation rater — pure ID-grep over `evidence`.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §4
 *
 * For each `memoryId` in `ctx.retrievedMemoryIds`:
 *   - if `ctx.evidence` contains the literal `memoryId` → +1 weight=0.5
 *     (positive citation; the agent referenced the memory's id somewhere
 *     in the task's `session_logs`).
 *   - else → -1 weight=0.25 (miss; we surfaced this memory but the agent
 *     did not cite it. Negative signal carries less confidence per
 *     IR convention from research §3.A and brainstorm Q4).
 *
 * The framework (`applyRating` in ./store.ts) sets `event.source` from the
 * rater's `name`. This rater MUST NOT populate `source` itself — `applyRating`
 * rejects rater-set sources to defend against rater spoofing.
 *
 * Match semantics: literal substring match using `String.prototype.includes`.
 * If two memory IDs share a prefix (e.g. `mem-A` is a prefix of `mem-AB`),
 * citing `mem-AB` will count as a hit for both. UUIDs (the production case)
 * never collide so this is benign; the unit tests lock the behaviour in.
 *
 * Pure / deterministic / no DB I/O.
 */
export class ImplicitCitationRater implements MemoryRater {
  readonly name = "implicit-citation";

  async rate(ctx: RatingContext): Promise<RatingEvent[]> {
    if (ctx.retrievedMemoryIds.length === 0) return [];
    const evidence = ctx.evidence ?? "";

    const events: RatingEvent[] = [];
    for (const memoryId of ctx.retrievedMemoryIds) {
      if (evidence.length > 0 && evidence.includes(memoryId)) {
        events.push({ memoryId, signal: 1, weight: 0.5, source: "" });
      } else {
        events.push({ memoryId, signal: -1, weight: 0.25, source: "" });
      }
    }
    return events;
  }
}
