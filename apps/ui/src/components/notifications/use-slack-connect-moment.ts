/** The bell's Slack Connect invite moment. The request itself: `@/hooks/use-slack-connect-invite`. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { SlackConnectMoment } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { slackConnectMoment } from "@/lib/notifications/slack-connect-moment";

/** The most recently updated failed task. A stable object, so the query key stays stable. */
const LAST_FAILED_TASK = { status: "failed", limit: 1, fields: "slim" } as const;

/**
 * The invite's moment, from the latest failed task and `/status`. Null while
 * `enabled` is false (then nothing polls) or while the inputs load.
 */
export function useSlackConnectMoment(enabled: boolean): SlackConnectMoment | null {
  const status = useStatusContext();
  // `useTasks` has no `enabled` option. Same key, so the cache is shared.
  const failed = useQuery({
    queryKey: ["tasks", LAST_FAILED_TASK],
    queryFn: () => api.fetchTasks(LAST_FAILED_TASK),
    enabled,
    refetchInterval: 60_000,
  });
  if (!enabled || !status.data || (failed.data === undefined && !failed.isError)) return null;
  const task = failed.data?.tasks[0];
  return slackConnectMoment({
    lastFailedAt: task ? (task.finishedAt ?? task.lastUpdatedAt) : null,
    workflowRunsCompleted: status.data?.instance?.workflow_runs_completed ?? 0,
  });
}
