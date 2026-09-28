import type { AgentTask, AgentTaskStatus } from "../api/types";

/**
 * Non-terminal statuses in the order the session header prefers them. The
 * first one present in the tree wins and is shown as-is, so each keeps its
 * own meaning:
 *
 * - `in_progress`: an agent is working on it now.
 * - `pending`: accepted, waiting to start.
 * - `unassigned`: in the pool, ready for any agent to claim.
 * - `reviewing` / `offered`: offered to an agent that has not accepted yet.
 *   An offer is not work in progress.
 * - `paused`: interrupted, can resume.
 * - `backlog` / `draft`: not dispatch-eligible yet.
 */
const OPEN_STATUS_PRIORITY: AgentTaskStatus[] = [
  "in_progress",
  "pending",
  "unassigned",
  "reviewing",
  "offered",
  "paused",
  "backlog",
  "draft",
];

export interface SessionStatus {
  /** Status to show for the whole session. */
  status: AgentTaskStatus;
  /** Tasks in the tree that ended in `failed`. */
  failedCount: number;
}

/**
 * Derive a session's status from its whole task tree, not the root alone.
 *
 * The root task can fail (for example, its first attempt dies in a server
 * restart) while a retry and its children keep working. Showing the root's
 * FAILED badge then tells the operator the work failed while agents are on it.
 *
 * The most advanced open status in the tree wins (see `OPEN_STATUS_PRIORITY`);
 * with nothing open, the most recently updated task's terminal status.
 */
export function deriveSessionStatus(root: AgentTask, chain: AgentTask[]): SessionStatus {
  const byId = new Map<string, AgentTask>();
  for (const task of [root, ...chain]) byId.set(task.id, task);
  const tasks = [...byId.values()];

  const failedCount = tasks.filter((t) => t.status === "failed").length;

  const present = new Set(tasks.map((t) => t.status));
  const open = OPEN_STATUS_PRIORITY.find((status) => present.has(status));
  if (open) return { status: open, failedCount };

  const latest = tasks.reduce((a, b) => (b.lastUpdatedAt > a.lastUpdatedAt ? b : a));
  return { status: latest.status, failedCount };
}
