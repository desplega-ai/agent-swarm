import cronstrue from "cronstrue";

// Translate a cron expression to plain English. Falls back to the raw
// expression on parse error. Used by the schedules list and detail pages so
// they stay in lockstep on the human-readable description shown alongside
// `<code>{cron}</code>`.

export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}

// Format an interval expressed in milliseconds as a compact "Xs", "Xm", "Xh"
// or "Xd" label, matching the schedules list / detail "Every {interval}"
// renderer.

export function formatInterval(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}
