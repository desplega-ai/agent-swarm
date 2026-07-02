/**
 * Phase 5 — small adapter-side pricing constants for claude-managed.
 *
 * The API server's pricing table is the canonical store (seeded by
 * `src/be/seed-pricing.ts`). Workers can't touch the DB directly (DB
 * boundary), so the adapter keeps a local constant for the runtime fee
 * and lets the API-side recompute path (Phase 2) override the resulting
 * `totalCostUsd` with the canonical figure. The constant here is what
 * shows up in the worker's local logs before the row hits the server.
 *
 * If/when we plumb pricing through the worker bootstrap (HTTP fetch of
 * `/api/pricing` at session start), this module is the place to swap.
 */

/**
 * USD per session-hour for managed claude runtime. Source:
 * https://docs.claude.com/en/api/agent-sdk/managed-runtime#pricing
 * (verified 2026-04-28). Override at runtime via env for ops bumps without
 * a redeploy.
 */
export const RUNTIME_FEE_USD_PER_HOUR = (() => {
  const raw = process.env.CLAUDE_MANAGED_RUNTIME_FEE_USD_PER_HOUR;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 0) return n;
  return 0.08;
})();

/**
 * Adapter helper. Always returns a finite number — never crashes the
 * cost snapshot.
 */
export function getRuntimeFeePerHour(): number {
  return RUNTIME_FEE_USD_PER_HOUR;
}
