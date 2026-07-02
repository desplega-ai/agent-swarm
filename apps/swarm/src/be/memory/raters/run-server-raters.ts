import {
  getRaterWeightMultiplier as defaultGetRaterWeightMultiplier,
  getRegisteredRaters as defaultGetRegisteredRaters,
  SERVER_RATERS,
} from "./registry";
import { type ApplyRatingResult, applyRating as defaultApplyRating } from "./store";
import type { MemoryRater, RatingEvent } from "./types";

/**
 * Inputs for `runServerRaters`. The caller is responsible for fetching
 * `retrievedMemoryIds` from `memory_retrieval` and the concatenated
 * `evidence` text from `session_logs` (both are trivial SELECTs already
 * covered by integration tests in memory-rater-implicit-citation.test.ts).
 */
export type RunServerRatersInput = {
  taskId: string;
  agentId: string;
  retrievedMemoryIds: string[];
  evidence: string;
};

/**
 * Optional overrides — primarily for unit tests so the orchestration logic
 * (filter → rate → stamp source → clamp weight → applyRating) can be
 * exercised with stub raters and an in-memory `applyRating`.
 */
export type RunServerRatersDeps = {
  raters?: MemoryRater[];
  serverRaterNames?: ReadonlySet<string>;
  weightMultiplierFor?: (name: string) => number;
  applyRating?: (events: RatingEvent[], ctx: { taskId?: string }) => ApplyRatingResult;
};

export type ServerRaterFireOutcome = {
  rater: string;
  events: RatingEvent[];
  result: ApplyRatingResult;
};

export type RunServerRatersResult = {
  ratersFired: number;
  outcomes: ServerRaterFireOutcome[];
};

/**
 * Fire every allow-listed server-side memory rater for a completed task,
 * stamp `source` from the rater's name (the framework's anti-spoof guarantee),
 * apply the configured `MEMORY_RATER_WEIGHTS` multiplier with a [0, 1] clamp,
 * then persist the resulting `RatingEvent`s via `applyRating`.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §5
 *
 * Extracted from the previous inline IIFE in `store-progress.ts` (PR #426
 * review feedback) so the orchestration is unit-testable in isolation —
 * `raters`, `serverRaterNames`, `weightMultiplierFor`, and `applyRating` are
 * all injectable. With no overrides, behaviour is byte-identical to the
 * original inline block.
 *
 * No-ops when `retrievedMemoryIds` is empty. Rater errors propagate; callers
 * are expected to wrap in try/catch (rater failure must NEVER affect task
 * status — see the `console.error` site in `store-progress.ts`).
 */
export async function runServerRaters(
  input: RunServerRatersInput,
  deps: RunServerRatersDeps = {},
): Promise<RunServerRatersResult> {
  const result: RunServerRatersResult = { ratersFired: 0, outcomes: [] };
  if (input.retrievedMemoryIds.length === 0) return result;

  const allRaters = deps.raters ?? defaultGetRegisteredRaters();
  const allowed = deps.serverRaterNames ?? SERVER_RATERS;
  const weightFor = deps.weightMultiplierFor ?? defaultGetRaterWeightMultiplier;
  const applyFn = deps.applyRating ?? defaultApplyRating;

  const serverRaters = allRaters.filter((r) => allowed.has(r.name));

  for (const rater of serverRaters) {
    const events = await rater.rate({
      taskId: input.taskId,
      agentId: input.agentId,
      retrievedMemoryIds: input.retrievedMemoryIds,
      evidence: input.evidence,
    });
    if (events.length === 0) continue;

    const multiplier = weightFor(rater.name);
    const stamped: RatingEvent[] = events.map((e) => ({
      ...e,
      source: rater.name,
      weight: Math.max(0, Math.min(1, e.weight * multiplier)),
    }));
    const applied = applyFn(stamped, { taskId: input.taskId });
    result.ratersFired += 1;
    result.outcomes.push({ rater: rater.name, events: stamped, result: applied });
  }
  return result;
}
