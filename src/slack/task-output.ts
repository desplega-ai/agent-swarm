import type { AgentTask } from "../types";

/**
 * Legacy deferral output, written before `defer-task` started storing the
 * human-facing card directly:
 *   `Deferred until {date} {time} ([shortId](url)) -> {note excerpt}`
 * Group 1 is the ETA; the schedule link and the note excerpt are dropped.
 */
const LEGACY_DEFERRAL_NOTICE = /^Deferred until ([^\n(]+?) \([^\n]*?\) -> .*$/;

/**
 * The Slack-facing form of a task's stored output.
 *
 * For a deferral this is the stored text verbatim — `defer-task` already
 * writes the human card (`Checking back today at 18:38`, or
 * `Waiting on Researcher — or today at 18:38 at the latest`). Rows written
 * before that change carried the agent's internal handoff note plus a raw
 * schedule UUID link instead, so they are rewritten to the ETA alone.
 */
export function slackTaskOutput(
  task: Pick<AgentTask, "output" | "tags" | "outputSchema" | "status">,
): string | undefined {
  const output = task.output ?? undefined;
  if (task.status !== "completed" || task.outputSchema || !task.tags?.includes("deferred")) {
    return output;
  }
  // Only match the engine-authored line from defer-task, not continuation results.
  const legacy = output?.match(LEGACY_DEFERRAL_NOTICE);
  if (!legacy) return output;
  const eta = legacy[1]?.trim();
  return eta ? `Checking back ${eta}` : output;
}

/**
 * A task that ENDED in a deferral. It is stored `completed` — `defer-task`
 * ends the task and books a wake-up — but to a human reading the thread the
 * work is still outstanding, so every glyph and card treats it as waiting.
 *
 * `deferredAt` is the exact signal. The `deferred` tag is not: `defer-task`
 * puts it on both the deferring task and the wake-up schedule, so a wake-up
 * child that simply finished is tag-identical to one that deferred again.
 * The tag is still consulted for rows written before `deferredAt` existed,
 * narrowed to tasks the scheduler did not create (`taskType !== "deferred"`),
 * where it is unambiguous.
 */
export function isDeferredTask(
  task: Pick<AgentTask, "tags" | "status" | "deferredAt" | "taskType">,
): boolean {
  if (task.status !== "completed") return false;
  if (task.deferredAt) return true;
  return !!task.tags?.includes("deferred") && task.taskType !== "deferred";
}

/** The wake-up tasks `defer-task` booked to continue `task`. */
export function deferralWakes<T extends Pick<AgentTask, "parentTaskId" | "taskType">>(
  task: Pick<AgentTask, "id">,
  threadTasks: readonly T[],
): T[] {
  return threadTasks.filter(
    (candidate) => candidate.parentTaskId === task.id && candidate.taskType === "deferred",
  );
}

/**
 * A deferred task that is still parked: none of its wake-ups has settled.
 * Once one has, the deferral is over — the answer (or the next deferral)
 * lives on the wake-up, and the deferring task reads as the `completed` it
 * is stored as.
 */
export function isAwaitingWake(
  task: Pick<AgentTask, "id" | "tags" | "status" | "deferredAt" | "taskType">,
  threadTasks: readonly Pick<AgentTask, "parentTaskId" | "taskType" | "status">[],
): boolean {
  if (!isDeferredTask(task)) return false;
  return !deferralWakes(task, threadTasks).some(
    (wake) =>
      wake.status === "completed" || wake.status === "failed" || wake.status === "cancelled",
  );
}
