// Map a free-form status string (task / agent log / dashboard event) to a
// `text-status-X` class. Centralised so the dashboard activity feed,
// `tasks/[id]` log timeline, and any future log surface stay in lockstep.
//
// Returns `text-primary` for unknown values — preserves the pre-Phase-10
// behaviour where rare statuses fell through to amber.

export function statusTextClass(status: string | null | undefined): string {
  switch (status) {
    case "completed":
      return "text-status-success";
    case "failed":
    case "cancelled":
      return "text-status-error";
    case "in_progress":
    case "busy":
      return "text-status-active";
    case "idle":
      return "text-status-success";
    case "offline":
      return "text-status-neutral";
    case "pending":
    case "offered":
    case "unassigned":
      return "text-status-pending";
    default:
      return "text-primary";
  }
}
