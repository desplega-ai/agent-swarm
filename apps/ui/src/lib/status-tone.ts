// Map a free-form status string (task / agent log / dashboard event) to a
// `text-status-X-strong` class (the text-emphasis stop — the canonical
// `status-X` stops are pale fills). Centralised so the dashboard activity feed,
// `tasks/[id]` log timeline, and any future log surface stay in lockstep.
//
// Returns `text-primary` for unknown values — preserves the pre-Phase-10
// behaviour where rare statuses fell through to amber.

export function statusTextClass(status: string | null | undefined): string {
  switch (status) {
    case "completed":
      return "text-status-success-strong";
    case "failed":
    case "cancelled":
      return "text-status-error-strong";
    case "in_progress":
    case "busy":
      return "text-status-active-strong";
    case "idle":
      return "text-status-success-strong";
    case "offline":
    case "superseded":
      return "text-status-neutral-strong";
    case "pending":
    case "offered":
    case "unassigned":
      return "text-status-pending-strong";
    default:
      return "text-primary";
  }
}
