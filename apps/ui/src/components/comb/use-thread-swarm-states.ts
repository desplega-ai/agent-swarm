import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/client";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import {
  isTaskUnfinished,
  type ThreadSwarmState,
  threadSwarmStates,
  threadsByTask,
} from "@/lib/comb/thread-status";
import { useCombServiceUserId } from "./use-comb-service-user";

/** How often a watched task's status is read while it runs. */
const PROCESSING_POLL_MS = 10_000;

/**
 * The task detail query of each id (`["task", id]`, the key `useTask` uses,
 * so the task page shares it): one request per task, since the API has no
 * read of several tasks by id. A task polls every 10 s until it finishes.
 */
export function useWatchedTasks(taskIds: readonly string[]) {
  return useQueries({
    queries: taskIds.map((id) => ({
      queryKey: ["task", id],
      queryFn: () => api.fetchTask(id),
      refetchInterval: (query: { state: { status: string; data?: { status: string } } }) =>
        query.state.status === "error" ||
        (query.state.data !== undefined && !isTaskUnfinished(query.state.data.status))
          ? false
          : PROCESSING_POLL_MS,
    })),
  });
}

/**
 * Unsent and processing threads by thread id (`threadSwarmStates`). Each
 * sent, unanswered thread watches its task (`useWatchedTasks`): one request
 * per distinct task, since one send makes one task for all its comments.
 * Nothing polls when no thread waits: an answer on the thread stops watching
 * its task.
 */
export function useThreadSwarmStates(
  threads: ReadonlyArray<CommentListEntry>,
): ReadonlyMap<string, ThreadSwarmState> {
  const serviceUserId = useCombServiceUserId();
  const taskIds = useMemo(
    () => [...threadsByTask(threads, serviceUserId).keys()].sort(),
    [threads, serviceUserId],
  );

  const results = useWatchedTasks(taskIds);

  // One string for every answer, so the states (and the highlights that read
  // them) change only when a status does.
  const statusKey = taskIds
    .map((id, index) => `${id}=${results[index]?.data?.status ?? ""}`)
    .join(",");
  return useMemo(() => {
    const statuses = new Map(
      statusKey
        .split(",")
        .filter(Boolean)
        .map((pair) => pair.split("=") as [string, string]),
    );
    return threadSwarmStates(threads, serviceUserId, (taskId) => statuses.get(taskId) || undefined);
  }, [threads, serviceUserId, statusKey]);
}
