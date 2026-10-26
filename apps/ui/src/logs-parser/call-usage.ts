import type { CallUsage, NormalizedItem } from "./types";

/** Session totals over every parsed LLM call. */
export interface CallUsageTotals {
  calls: number;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Σ cache read / Σ prompt tokens, or null for an empty prompt. */
  ratio: number | null;
  /** False when no call read or wrote cache (some providers report none). */
  cacheReported: boolean;
}

/** Share of the prompt read from cache, or null for an empty prompt. */
export function cacheHitRatio(
  u: Pick<CallUsage, "promptTokens" | "cacheReadTokens">,
): number | null {
  return u.promptTokens ? u.cacheReadTokens / u.promptTokens : null;
}

/** Totals over the given calls, or null when there are none. */
export function sumCallUsage(usages: Iterable<CallUsage>): CallUsageTotals | null {
  let calls = 0;
  let promptTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const u of usages) {
    calls++;
    promptTokens += u.promptTokens;
    cacheReadTokens += u.cacheReadTokens;
    cacheWriteTokens += u.cacheWriteTokens;
  }
  if (calls === 0) return null;
  return {
    calls,
    promptTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ratio: cacheHitRatio({ promptTokens, cacheReadTokens }),
    cacheReported: cacheReadTokens > 0 || cacheWriteTokens > 0,
  };
}

/** Totals over the `call_usage` items of a parsed session. */
export function sumItemCallUsage(items: NormalizedItem[]): CallUsageTotals | null {
  return sumCallUsage(
    items.flatMap((item) => (item.kind === "call_usage" && item.usage ? [item.usage] : [])),
  );
}
