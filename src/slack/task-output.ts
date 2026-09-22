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
