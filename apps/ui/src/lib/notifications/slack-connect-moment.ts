import type { SlackConnectMoment } from "@/api/types";

/** A failed task this recent makes the invite offer help with it. */
export const SLACK_CONNECT_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Up to this many completed workflow runs still reads as "Your first workflow ran". */
export const SLACK_CONNECT_FIRST_WORKFLOW_MAX_RUNS = 3;

/**
 * What the Slack Connect invite talks about: a task that failed in the last 7
 * days, else one of the first few completed workflow runs, else the plain invite.
 */
export function slackConnectMoment(input: {
  /** When the most recently updated failed task finished, or null. */
  lastFailedAt: string | null;
  /** `/status` `instance.workflow_runs_completed`. */
  workflowRunsCompleted: number;
  nowMs?: number;
}): SlackConnectMoment {
  const failedMs = input.lastFailedAt ? Date.parse(input.lastFailedAt) : Number.NaN;
  const nowMs = input.nowMs ?? Date.now();
  if (Number.isFinite(failedMs) && nowMs - failedMs < SLACK_CONNECT_FAILURE_WINDOW_MS) {
    return "task_failed";
  }
  const runs = input.workflowRunsCompleted;
  if (runs >= 1 && runs <= SLACK_CONNECT_FIRST_WORKFLOW_MAX_RUNS) return "first_workflow";
  return "default";
}
