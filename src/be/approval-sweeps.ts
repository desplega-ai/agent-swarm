export const DEFAULT_APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS = 7;

// Days a pending approval request with no explicit expiresAt may wait before
// the heartbeat sweep cancels it. 0 turns auto-cancellation off.
//
// Read DYNAMICALLY, not captured at module load: this module is imported by
// the heartbeat before `loadGlobalConfigsIntoEnv()` hydrates swarm_config
// into `process.env`, so a module-level capture would leave a
// dashboard-saved override permanently inert (even across restarts).
export function approvalRequestAutoCancellationDays(): number {
  const raw = process.env.APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS;
  if (raw != null && /^\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return DEFAULT_APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS;
}
