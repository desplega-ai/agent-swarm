import type { AgentTaskStatus } from "@/api/types";

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Tri-state liveness for a task, used by the session-log viewer footer.
 *
 * - `true`      → actively working (`in_progress`) → "Agent is working…"
 * - `false`     → finished (`completed` / `failed` / `cancelled`) → "Session complete"
 * - `undefined` → indeterminate (queued, paused, reviewing, …) → neutral footer,
 *                 so we never falsely claim a paused/pending task is "complete".
 */
export function taskIsRunning(status: AgentTaskStatus | undefined): boolean | undefined {
  if (!status) return undefined;
  if (status === "in_progress") return true;
  if (TERMINAL_STATUSES.has(status)) return false;
  return undefined;
}
