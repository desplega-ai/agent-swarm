/**
 * Pricing table for Anthropic-managed Claude models, mirroring the layout of
 * `src/providers/codex-models.ts`. Rates are USD per million tokens (Mtok)
 * sourced from https://platform.claude.com/docs/en/about-claude/pricing
 * (verified 2026-04-28).
 *
 * The managed-agents API does NOT report dollar cost on the `span.model_request_end`
 * event — only token counts (`input_tokens`, `output_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`). Phase 4 of the
 * provider plan computes USD locally via {@link computeClaudeManagedCostUsd},
 * then folds in Anthropic's $0.08/session-hour runtime fee inside the adapter.
 *
 * Bump this file when Anthropic publishes new rates or new models.
 *
 * Cache nomenclature mapping:
 * - `cache_read_input_tokens`        → "cache hit" rate     (cheapest)
 * - `cache_creation_input_tokens`    → "cache write" rate   (input × 1.25 for 5m TTL)
 * - regular `input_tokens` (uncached) → standard input rate
 *
 * Anthropic's pricing page lists 5-minute and 1-hour cache TTLs separately;
 * managed-agents currently uses the 5-minute breakpoint by default, which is
 * the rate captured here. If a future SDK release surfaces TTL on the usage
 * payload, refine these by TTL.
 */

/** Models supported by the managed-agents surface for the swarm worker. */
export const CLAUDE_MANAGED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
] as const;

export type ClaudeManagedModel = (typeof CLAUDE_MANAGED_MODELS)[number];

/** Pricing per million tokens (USD). */
export interface ClaudeManagedModelPricing {
  /** USD per million uncached input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million tokens read from prompt cache. */
  cacheReadPerMillion: number;
  /** USD per million tokens written to prompt cache (5-minute TTL). */
  cacheWritePerMillion: number;
}

/**
 * Anthropic public list pricing as of 2026-04-28. Source:
 * https://platform.claude.com/docs/en/about-claude/pricing
 *
 * - claude-sonnet-4-6: $3 / $15 / $0.30 / $3.75    (in / out / cache-read / cache-write)
 * - claude-opus-4-7:   $15 / $75 / $1.50 / $18.75
 * - claude-haiku-4-5:  $1 / $5 / $0.10 / $1.25
 */
export const CLAUDE_MANAGED_MODEL_PRICING: Record<ClaudeManagedModel, ClaudeManagedModelPricing> = {
  "claude-sonnet-4-6": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-opus-4-7": {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
};

/**
 * Models we've already warned about — keeps `console.warn` from spamming the
 * worker logs when an old session keeps replaying through `span.model_request_end`
 * events with an unrecognized model string.
 */
const warnedUnknownModels = new Set<string>();

/**
 * Compute USD cost for one Claude managed-agents session, given the SDK's
 * accumulated token counts.
 *
 * Returns `0` (with a deduplicated `console.warn`) for unknown model strings —
 * we'd rather under-report than make up a number on a typo.
 *
 * Note: the runtime $0.08/session-hour fee is NOT folded in here. The adapter
 * computes that separately because it depends on the session's wallclock
 * `durationMs`, which is provider-state, not token-state.
 */
export function computeClaudeManagedCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const pricing = CLAUDE_MANAGED_MODEL_PRICING[model as ClaudeManagedModel];
  if (!pricing) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(
        `[claude-managed-models] Unknown model "${model}" — returning $0 cost. ` +
          `Add it to CLAUDE_MANAGED_MODEL_PRICING in src/providers/claude-managed-models.ts.`,
      );
    }
    return 0;
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
