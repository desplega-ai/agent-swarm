/**
 * Context window size lookup and usage computation utilities.
 *
 * This module is safe for both API and worker code — it has NO database imports.
 */

const CONTEXT_WINDOW_DEFAULTS: Record<string, number> = {
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
  default: 200_000,
};

/**
 * Look up the context window size (in tokens) for a given model identifier.
 * Falls back to the "default" entry when the model is not explicitly mapped.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getContextWindowSize(model: string): number {
  return CONTEXT_WINDOW_DEFAULTS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compute the total context tokens used from a Claude API usage object.
 * Sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
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
