// Single source of truth for "compact ms duration" labels. Two call sites:
//   • tasks/[id] cost panel — default mode, whole-second rounding:
//       < 1000ms → "423ms" · < 60s → "42s" · < 60m → "5m 12s" · ≥ 60m → "1h 5m"
//   • script-runs timeline (via step-shared) — `precise: true`, sub-second
//     fidelity so short steps don't all read "0s":
//       < 1000ms → "423ms" · < 10s → "2.31s" · < 60s → "42s" · then m/h
//
// Distinct from `formatDuration(ms)` in `lib/utils.ts` which always rounds to
// whole seconds (no `Xms` form). Keeping both modes here means the two call
// sites can't drift apart with subtly different rounding.

export function formatDurationMs(ms: number, opts?: { precise?: boolean }): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (opts?.precise) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(2).replace(/0$/, "")}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    if (m < 60) return `${m}m ${rem}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
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
