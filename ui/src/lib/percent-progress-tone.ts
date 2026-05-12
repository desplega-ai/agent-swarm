// Map a 0–100 percentage to a Progress indicator class for the
// `[&_[data-slot=progress-indicator]]:bg-status-X` form used by the shadcn
// Progress primitive. Two thresholds ("warning" at >50%, "error" at >80%) match
// the pre-Phase-10 page-local helper in `tasks/[id]/page.tsx`.

export function progressBarTone(percent: number): string {
  if (percent > 80) return "[&_[data-slot=progress-indicator]]:bg-status-error";
  if (percent > 50) return "[&_[data-slot=progress-indicator]]:bg-status-warning";
  return "[&_[data-slot=progress-indicator]]:bg-status-success";
}
