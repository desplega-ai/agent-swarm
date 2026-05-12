import { ExplicitSelfRatingRater } from "./explicit-self";
import { ImplicitCitationRater } from "./implicit-citation";
import { LlmRater } from "./llm";
import { NoopRater } from "./noop";
import type { MemoryRater } from "./types";

/**
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-1.md §4
 *
 * `MEMORY_RATERS` env — comma-separated list of rater names. Defaults to
 * `[NoopRater]` when unset/empty so existing deployments stay byte-identical.
 *
 * `MEMORY_RATER_WEIGHTS` env — optional `name:multiplier,...` overrides.
 * Multiplier is applied to every emitted RatingEvent.weight before
 * `applyRating`. Default = 1.0.
 *
 * Each later step touches *only* its own line in the factory map:
 *   - step-1: noop only (this PR).
 *   - step-2: implicit-citation.
 *   - step-4: llm.
 *   - step-5: explicit-self.
 *
 * Unknown names are logged and skipped — startup never fails on this.
 */

type RaterFactory = () => MemoryRater;

const FACTORIES: Record<string, RaterFactory> = {
  noop: () => new NoopRater(),
  "implicit-citation": () => new ImplicitCitationRater(),
  "explicit-self": () => new ExplicitSelfRatingRater(),
  llm: () => new LlmRater(),
};

/**
 * Raters whose `rate(ctx)` runs server-side (in `store-progress.ts` after task
 * completion). Worker-driven raters (e.g. step-4's `LlmRater`, step-5's
 * `ExplicitSelfRater`) emit events from outside this set and POST them to
 * `/api/memory/rate`. The store-progress hook only fires raters listed here.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §6
 */
export const SERVER_RATERS = new Set<string>(["implicit-citation"]);

export function getRegisteredRaters(): MemoryRater[] {
  const raw = process.env.MEMORY_RATERS;
  if (!raw || raw.trim() === "") {
    return [new NoopRater()];
  }

  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const raters: MemoryRater[] = [];
  for (const name of names) {
    const factory = FACTORIES[name];
    if (!factory) {
      console.warn(`[memory-rater] Unknown rater "${name}" in MEMORY_RATERS — skipping`);
      continue;
    }
    raters.push(factory());
  }

  if (raters.length === 0) {
    return [new NoopRater()];
  }
  return raters;
}

export function getRaterWeightMultiplier(name: string): number {
  const raw = process.env.MEMORY_RATER_WEIGHTS;
  if (!raw || raw.trim() === "") return 1.0;

  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const [rawName, rawMult] = trimmed.split(":");
    if (!rawName || !rawMult) continue;
    if (rawName.trim() !== name) continue;
    const mult = Number(rawMult);
    if (Number.isFinite(mult) && mult >= 0) return mult;
  }
  return 1.0;
}
