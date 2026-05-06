// Format an integer millisecond duration as the most compact human-readable
// label. Used by tasks/[id] cost panel:
//   < 1000ms  → "423ms"
//   < 60s     → "42s"
//   < 60m     → "5m 12s"
//   ≥ 60m     → "1h 5m"
//
// Distinct from `formatDuration(ms)` in `lib/utils.ts` which always rounds to
// whole seconds (no `Xms` form). Kept separate so the two existing call sites
// don't accidentally diverge.

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
