import { resolveRequesterTimezone } from "../be/requester-timezone";
import type { AgentTask } from "../types";
import { formatDeferralDateTime } from "../utils/deferral-time";

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
 * Re-render an engine-authored deferral from its wake-up instant using the
 * requester's current timezone. Older rows without an instant get a text-only card.
 */
export async function slackTaskOutput(
  task: Pick<
    AgentTask,
    "output" | "tags" | "outputSchema" | "status" | "deferredUntil" | "requestedByUserId"
  >,
  now: Date = new Date(),
): Promise<string | undefined> {
  const output = task.output ?? undefined;
  if (
    !output ||
    task.status !== "completed" ||
    task.outputSchema ||
    !task.tags?.includes("deferred")
  ) {
    return output;
  }
  const waitingOn = output.match(EVENT_DEFERRAL_CARD)?.[1];
  if (!waitingOn && !LEGACY_DEFERRAL_NOTICE.test(output) && !TIME_DEFERRAL_CARD.test(output)) {
    return output;
  }
  if (!task.deferredUntil) return waitingOn ? `Waiting on ${waitingOn}` : "Checking back later";

  const { tz, isFallback } = await resolveRequesterTimezone(
    task.requestedByUserId,
    process.env.SLACK_DEFAULT_TIMEZONE,
  );
  const { date, time } = formatDeferralDateTime(new Date(task.deferredUntil), now, tz, isFallback);
  const resumes = date === "today" ? time : `${date} ${time}`;
  return waitingOn
    ? `Waiting on ${waitingOn} · resumes by ${resumes}`
    : `Checking back ${date === "today" ? "at " : ""}${resumes}`;
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
      wake.status === "completed" ||
      wake.status === "failed" ||
      wake.status === "cancelled" ||
      wake.status === "skipped",
  );
}
