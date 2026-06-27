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
  /**
   * Optional free-form external source identifier (v1.5 wedge — step-6).
   *
   * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-6.md §1-§2
   *
   * When present, `applyRating` UPSERTs into `agent_memory_edge` with
   * `type='references-source'`, applying the same Beta posterior delta as
   * the memory row's `(alpha, beta)`. Convention `<source>:<identifier>`
   * (e.g. `github:owner/repo#N`, `linear:KEY-N`, `customer:<slug>`) is
   * documentation-only — server does NOT validate prefixes. Validation is
   * write-site only: non-empty, ≤512 chars, control-char strip, no NUL.
   */
  referencesSource?: string;
};

/**
 * Maximum byte length for `referencesSource` strings (Q2 contract). Encoded
 * here once so the HTTP Zod schema, the MCP tool input schema, the LlmRater
 * Zod schema, and `sanitizeReferencesSource` can't drift.
 */
export const REFERENCES_SOURCE_MAX_LENGTH = 512;

const NUL_CHAR_CODE = 0x00;
const DEL_CHAR_CODE = 0x7f;
const FIRST_PRINTABLE_ASCII = 0x20;

/**
 * Strip control characters from a `referencesSource` string and reject NUL
 * bytes outright (Q2 free-form contract — step-6.md §2).
 *
 * - Returns the cleaned string when valid.
 * - Returns `null` when the input contains a NUL byte (charCode 0x00) or
 *   when stripping control chars produces an empty string. Callers treat
 *   `null` as a validation failure (Zod transform → `z.NEVER`, applyRating
 *   → reject).
 *
 * Length is checked OUTSIDE this helper (Zod `.max(512)` runs first); the
 * helper itself does not enforce a max so callers can apply different
 * policies.
 */
export function sanitizeReferencesSource(input: string): string | null {
  let stripped = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === NUL_CHAR_CODE) return null;
    if (code < FIRST_PRINTABLE_ASCII || code === DEL_CHAR_CODE) {
      // Non-NUL C0 / DEL — silently stripped.
      continue;
    }
    stripped += input[i];
  }
  if (stripped.length === 0) return null;
  return stripped;
}

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
