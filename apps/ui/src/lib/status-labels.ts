/**
 * The one name map for every status the dashboard draws: agent and service
 * health, the task lifecycle, workflow runs and steps, approval requests.
 * `StatusBadge` shows the uppercase chip form; prose (Activity, waiting text)
 * uses `statusLabel`, so a raw value such as `in_progress` never shows.
 */
export const STATUS_LABELS: Record<string, string> = {
  // Agent statuses
  idle: "IDLE",
  busy: "BUSY",
  offline: "OFFLINE",
  waiting_for_credentials: "WAITING FOR CREDS",

  // Task statuses. `draft` is the transient "attachments still uploading" state.
  draft: "UPLOADING",
  backlog: "BACKLOG",
  unassigned: "UNASSIGNED",
  offered: "OFFERED",
  reviewing: "REVIEWING",
  pending: "PENDING",
  in_progress: "IN PROGRESS",
  paused: "PAUSED",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  superseded: "SUPERSEDED",
  aborted_limit: "ABORTED LIMIT",

  // Service statuses
  starting: "STARTING",
  healthy: "HEALTHY",
  unhealthy: "UNHEALTHY",
  stopped: "STOPPED",

  // Workflow run statuses
  running: "RUNNING",
  waiting: "WAITING",

  // Workflow step statuses
  skipped: "SKIPPED",

  // Approval request statuses
  approved: "APPROVED",
  rejected: "REJECTED",
  timeout: "TIMEOUT",
};

/**
 * Sentence-case status name for prose: `in_progress` reads "In progress".
 * An unknown value is humanized the same way (`foo_bar` reads "Foo bar").
 */
export function statusLabel(status: string): string {
  const words = (STATUS_LABELS[status] ?? status.replace(/_/g, " ")).toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
