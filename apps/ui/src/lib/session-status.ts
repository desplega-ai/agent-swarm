import type { AgentTask, AgentTaskStatus } from "../api/types";

/** Statuses that mean an agent is working on the task right now. */
const LIVE_STATUSES = new Set<AgentTaskStatus>(["in_progress", "offered", "reviewing"]);
/** Statuses that mean the task is queued and will run. */
const QUEUED_STATUSES = new Set<AgentTaskStatus>(["pending", "backlog", "unassigned", "draft"]);

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
 * Order: any live task → `in_progress`; else any queued task → `pending`;
 * else any paused task → `paused`; else the most recently updated task's
 * terminal status.
 */
export function deriveSessionStatus(root: AgentTask, chain: AgentTask[]): SessionStatus {
  const byId = new Map<string, AgentTask>();
  for (const task of [root, ...chain]) byId.set(task.id, task);
  const tasks = [...byId.values()];

  const failedCount = tasks.filter((t) => t.status === "failed").length;

  if (tasks.some((t) => LIVE_STATUSES.has(t.status))) {
    return { status: "in_progress", failedCount };
  }
  if (tasks.some((t) => QUEUED_STATUSES.has(t.status))) {
    return { status: "pending", failedCount };
  }
  if (tasks.some((t) => t.status === "paused")) {
    return { status: "paused", failedCount };
  }

  const latest = tasks.reduce((a, b) => (b.lastUpdatedAt > a.lastUpdatedAt ? b : a));
  return { status: latest.status, failedCount };
}
