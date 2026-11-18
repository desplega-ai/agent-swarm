import type { AgentTask } from "../types";
import { formatDeferralDateTime } from "../utils/deferral-time";

// shortcut: one timezone for every channel post; switch to the requester's
// `users.timezone` once Slack ingest stores it for most people.
const CHANNEL_TZ = "Europe/Madrid";

/** "04:00", "tomorrow 04:00" or "11-20 04:00", in `CHANNEL_TZ`. */
function channelResumeTime(iso: string, now: Date): string {
  const { date, time } = formatDeferralDateTime(new Date(iso), now, CHANNEL_TZ);
  return date === "today" ? time : `${date} ${time}`;
}

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
 * A deferral's stored card (`Checking back today at 18:38`, `Waiting on
 * Researcher — or today at 18:38 at the latest`) renders its time in the
 * requester's timezone, or UTC when they have none. Slack re-renders it from
 * `deferredUntil` in `CHANNEL_TZ`: `Checking back at 18:38` / `Waiting on
 * Researcher · resumes by 18:38`. Rows without `deferredUntil` (deferred
 * before it existed, or the legacy notice with the agent's internal handoff
 * note and a raw schedule UUID link) read `Checking back later` /
 * `Waiting on Researcher`.
 */
export function slackTaskOutput(
  task: Pick<AgentTask, "output" | "tags" | "outputSchema" | "status" | "deferredUntil">,
  now: Date = new Date(),
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
  const resumes = task.deferredUntil ? channelResumeTime(task.deferredUntil, now) : null;
  // Only match the engine-authored card from defer-task, not continuation results.
  if (LEGACY_DEFERRAL_NOTICE.test(output) || TIME_DEFERRAL_CARD.test(output)) {
    if (!resumes) return "Checking back later";
    return `Checking back ${resumes.includes(" ") ? "" : "at "}${resumes}`;
  }
  const waitingOn = output.match(EVENT_DEFERRAL_CARD)?.[1];
  if (!waitingOn) return output;
  return resumes ? `Waiting on ${waitingOn} · resumes by ${resumes}` : `Waiting on ${waitingOn}`;
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
