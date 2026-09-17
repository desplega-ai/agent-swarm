import type { AgentTask } from "../types";

/** Keep the stored deferral ETA for task details, but omit it from Slack. */
export function slackTaskOutput(
  task: Pick<AgentTask, "output" | "tags" | "outputSchema" | "status">,
): string | undefined {
  const output = task.output ?? undefined;
  if (task.status !== "completed" || task.outputSchema || !task.tags?.includes("deferred")) {
    return output;
  }
  // Only match the engine-authored line from defer-task, not continuation results.
  const notice = output?.match(/^Deferred until [^\n]+? \([^\n]+?\) -> (.*)$/);
  if (!notice) return output;
  const pending = notice[1]?.trim();
  return pending ? `Pending: ${pending}` : "";
}

/** An ETA-only notice has no useful content left to post. */
export function isSlackEtaOnlyNotice(task: AgentTask): boolean {
  return !!task.output && slackTaskOutput(task) === "";
}
