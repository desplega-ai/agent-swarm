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
