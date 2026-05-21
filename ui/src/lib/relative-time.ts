import { parseUTCDate } from "./utils";

/**
 * Compact relative-time formatter optimized for dense tables (identities,
 * events, audit logs).
 *
 *   < 30s    → "just now"
 *   < 60m    → "4m ago"
 *   < 24h    → "2h ago"
 *   < 7d     → "3d ago"
 *   ≥ 7d     → "May 18"  (or "May 18, 2024" if not current year)
 *
 * Pair with the absolute timestamp on hover (use a Tooltip wrapping the
 * formatted value with the raw ISO string in TooltipContent).
 */
export function formatRelative(dateInput: string | Date): string {
  const d = typeof dateInput === "string" ? parseUTCDate(dateInput) : dateInput;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 30) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}
