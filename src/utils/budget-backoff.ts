/**
 * Phase 4 — exponential back-off for `budget_refused` poll responses.
 *
 * The worker poll loop short-circuits on `trigger.type === "budget_refused"`
 * to avoid busy-looping the API while the agent is over-budget. Each
 * consecutive refusal doubles the sleep, capped at 5 minutes (per the
 * scoping decision in the per-agent-daily-cost-budget plan).
 *
 * This module is a pure helper so it can be unit-tested in isolation
 * without standing up the full poll loop.
 */

/** Hard cap on back-off, per the plan (5 minutes). */
export const BUDGET_BACKOFF_CAP_MS = 5 * 60 * 1000;

/**
 * Compute the back-off delay for the Nth consecutive `budget_refused`
 * trigger. The first refusal sleeps `basePollMs`; each subsequent one
 * doubles, capped at {@link BUDGET_BACKOFF_CAP_MS}.
 *
 * @param consecutiveRefusals - 1-indexed count of consecutive refusals
 *        (i.e. the Nth refusal in a row, including the current one).
 *        Must be >= 1; values < 1 fall back to `basePollMs`.
 * @param basePollMs - Base poll interval (today's `PollIntervalMs`, ~2s).
 * @returns Sleep duration in milliseconds, capped at 5 minutes.
 */
export function computeBudgetBackoffMs(consecutiveRefusals: number, basePollMs: number): number {
  const n = Math.max(1, Math.floor(consecutiveRefusals));
  // 2 ** (n-1) grows quickly; cap before multiplying to avoid Infinity for
  // pathological inputs. JS handles 2 ** 30 fine but cap-first is cleaner.
  const exponent = Math.min(30, n - 1);
  const raw = basePollMs * 2 ** exponent;
  return Math.min(BUDGET_BACKOFF_CAP_MS, raw);
}
