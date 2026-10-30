import type { AgentTask } from "@/api/types";

/**
 * The task page steers any assignee: a running task directly, a `pending` one
 * by queueing until its session starts, and a `paused` one by resuming it. A
 * finished task gets the follow-up box instead. The caller also checks that
 * the server supports steering and has it on.
 */
export function canSteerTask(task: Pick<AgentTask, "status">): boolean {
  return task.status === "in_progress" || task.status === "pending" || task.status === "paused";
}

/**
 * Sessions steers only its latest task, and only when it is a lead task that
 * is running or `pending` (the server holds the message until the session
 * starts). Anything else sends a follow-up task, which the server routes to
 * the Lead. The caller also checks that the server supports steering and has
 * it on.
 */
export function canSteerSessionTask(
  task: Pick<AgentTask, "status" | "isLeadTask"> | null | undefined,
): boolean {
  return !!task?.isLeadTask && (task.status === "in_progress" || task.status === "pending");
}

/**
 * The task the Sessions composer talks to. The newest live lead task, so a
 * message steers the turn that is running even while a delegated worker
 * task is the newest in the chain. With none live, the newest task: the
 * message follows up on it, and the new task joins the same session.
 */
export function sessionComposerTarget<
  T extends Pick<AgentTask, "status" | "isLeadTask" | "createdAt">,
>(chain: readonly T[]): T | null {
  const newestFirst = [...chain].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return newestFirst.find((task) => canSteerSessionTask(task)) ?? newestFirst[0] ?? null;
}
