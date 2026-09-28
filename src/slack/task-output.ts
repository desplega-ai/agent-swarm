import type { AgentTask } from "../types";

/**
 * Legacy deferral output, written before `defer-task` started storing the
 * human-facing card directly:
 *   `Deferred until {date} {time} ([shortId](url)) -> {note excerpt}`
 */
const LEGACY_DEFERRAL_NOTICE = /^Deferred until [^\n(]+? \([^\n]*?\) -> .*$/;

/** `renderWhen` in defer-task: `today at 18:38`, `tomorrow at …`, `on 09-24 at 18:38 UTC`. */
const WHEN = String.raw`(?:today|tomorrow|on \S+) at [^\n]+?`;

/** Time-based card `defer-task` stores: `Checking back today at 18:38`. */
const TIME_DEFERRAL_CARD = new RegExp(`^Checking back ${WHEN}$`);

/**
 * Event-based card `defer-task` stores:
 * `Waiting on Researcher — or today at 18:38 at the latest`. Group 1 is who
 * the deferral waits on.
 */
const EVENT_DEFERRAL_CARD = new RegExp(`^Waiting on ([^\\n]+?) — or ${WHEN} at the latest$`);

/**
 * The Slack-facing form of a task's stored output.
 *
 * A deferral's card never shows its wake-up time in Slack: the stored card
 * (`Checking back today at 18:38`, `Waiting on Researcher — or today at 18:38
 * at the latest`) keeps it for the API and the UI, and Slack reads
 * `Checking back later` / `Waiting on Researcher`. Rows written before
 * `defer-task` stored the card carried the agent's internal handoff note and
 * a raw schedule UUID link instead; they read `Checking back later` too.
 */
export function slackTaskOutput(
  task: Pick<AgentTask, "output" | "tags" | "outputSchema" | "status">,
): string | undefined {
  const output = task.output ?? undefined;
  if (
    !output ||
    task.status !== "completed" ||
    task.outputSchema ||
    !task.tags?.includes("deferred")
  ) {
    return output;
  }
  // Only match the engine-authored card from defer-task, not continuation results.
  if (LEGACY_DEFERRAL_NOTICE.test(output) || TIME_DEFERRAL_CARD.test(output)) {
    return "Checking back later";
  }
  const waitingOn = output.match(EVENT_DEFERRAL_CARD)?.[1];
  return waitingOn ? `Waiting on ${waitingOn}` : output;
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
