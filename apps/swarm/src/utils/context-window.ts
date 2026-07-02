/**
 * Context window size lookup and usage computation utilities.
 *
 * This module is safe for both API and worker code — it has NO database imports.
 *
 * Phase 4 + Phase 9 of the cost-tracking plan:
 *   - `getContextWindowSize` now resolves shortnames, family-versioned ids
 *     (`claude-sonnet-4-6`), AND dated full ids (`claude-sonnet-4-6-20251004`)
 *     by stripping the trailing date suffix. Previously the dated form fell
 *     to the 200k default — wildly wrong for sonnet/opus 4.x.
 *   - `computeContextUsedUnified` is the canonical formula every adapter
 *     should use when emitting a `context_usage` event:
 *       contextUsedTokens = input + cache_read + cache_create + output
 *     The matching `CONTEXT_FORMULA` constant is what adapters stamp onto
 *     the snapshot's `contextFormula` field.
 *   - The legacy `computeContextUsed` stays for back-compat reads but is
 *     deprecated; new code should use `computeContextUsedUnified`.
 */

/**
 * Phase 9: stamp this onto every `context_usage` event the adapter emits.
 * Callers that compute their own number for legacy reasons (e.g. pi-mono
 * delegates to the pi-ai SDK) use a different value — see `ContextFormula`
 * in `src/types.ts`.
 */
export const CONTEXT_FORMULA = "input-cache-output" as const;

const CONTEXT_WINDOW_DEFAULTS: Record<string, number> = {
  // Anthropic Fable / Mythos tier
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  // Anthropic 4.x family
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-5": 1_000_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4-0": 200_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 1_000_000,
  "claude-sonnet-4-0": 200_000,
  "claude-haiku-4-5": 200_000,
  // Anthropic 3.x family (legacy)
  "claude-3-7-sonnet": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-haiku": 200_000,
  // Shortnames used by the local-CLI adapter and pi-mono OpenRouter mirror.
  fable: 1_000_000,
  mythos: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
  default: 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Strip a trailing date suffix from a Claude model id so dated full ids
 * resolve to the same window as the family-versioned id.
 *
 * `claude-sonnet-4-6-20251004` → `claude-sonnet-4-6`
 * `claude-haiku-4-5-20251001`  → `claude-haiku-4-5`
 *
 * Anthropic's dated full ids are always `${family}-${major}-${minor}-${YYYYMMDD}`,
 * so an 8-digit trailing date is a reliable signal.
 */
function stripAnthropicDateSuffix(model: string): string {
  return model.replace(/-(\d{8})$/, "");
}

export function getContextWindowSize(model: string): number {
  // Fast path: exact match (shortname or family-versioned id).
  if (CONTEXT_WINDOW_DEFAULTS[model] !== undefined) {
    return CONTEXT_WINDOW_DEFAULTS[model];
  }
  // Dated full id → strip suffix and retry.
  const stripped = stripAnthropicDateSuffix(model);
  if (stripped !== model && CONTEXT_WINDOW_DEFAULTS[stripped] !== undefined) {
    return CONTEXT_WINDOW_DEFAULTS[stripped];
  }
  // OpenAI / GPT family — most reasoning models have 200k+; we keep this
  // conservative and let callers override via models.dev rates if they want.
  // Specific gpt-5.x context windows are >1M but the local-CLI adapter
  // generally doesn't surface those; the API recompute path uses the rate
  // table, not the window. The 200k default keeps the math safe.
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compute the total context tokens used from a Claude API usage object.
 * Sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
 *
 * @deprecated Phase 9 — use {@link computeContextUsedUnified} instead. This
 * variant excludes output tokens, which is the wrong number when the goal is
 * "how full is the model's context window right now."
 */
export function computeContextUsed(usage: {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/**
 * Phase 9: the unified context-used formula adapters should use when emitting
 * `context_usage` events. Sums input + cache_read + cache_create + output,
 * which is the number the Claude Code status line shows. Cross-provider
 * comparisons (claude vs codex vs pi) are only meaningful when every adapter
 * agrees on this formula.
 *
 * Returns 0 if every field is missing; callers should check the `contextTotal`
 * separately and emit `null` for `contextPercent` when the window is unknown.
 */
export function computeContextUsedUnified(parts: {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreateTokens?: number | null;
  outputTokens?: number | null;
}): number {
  return (
    (parts.inputTokens ?? 0) +
    (parts.cacheReadTokens ?? 0) +
    (parts.cacheCreateTokens ?? 0) +
    (parts.outputTokens ?? 0)
  );
}

/**
 * Phase 9: clamp a raw context-percent value to [0, 100]. Returns null when
 * `total` is missing or 0 so callers can show "unknown" instead of a
 * divide-by-zero NaN/∞.
 */
export function clampContextPercent(used: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  const raw = (used / total) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, raw));
}
