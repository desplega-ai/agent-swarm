import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { TaskLineageResponse } from "@/api/types";
import { allTasksTerminal } from "@/lib/task-activity";
import { taskPathFrom } from "./task-trail";

/** How often a path with a live task refetches (ids never change, only titles and statuses). */
const LIVE_PATH_POLL_MS = 15_000;

/**
 * The path from the session root down to `taskId`: the breadcrumb's
 * ancestors and the task page's Session link, one fetch for both. It asks
 * `GET /api/tasks/{id}/lineage` for one node at depth 1, so the server sends
 * the path rows only, not the whole tree (`useTaskLineage` polls that for
 * the lineage page). A 200 also means the caller can read the session: the
 * route checks session access.
 */
export function useTaskPath(taskId: string | undefined) {
  return useQuery({
    queryKey: ["task-lineage", taskId, "path"],
    queryFn: ({ signal }) =>
      api.getList<TaskLineageResponse>(
        `/api/tasks/${encodeURIComponent(taskId!)}/lineage`,
        { maxNodes: 1, maxDepth: 1 },
        signal,
      ),
    enabled: !!taskId,
    select: (data) => taskPathFrom(data, taskId!),
    staleTime: LIVE_PATH_POLL_MS,
    retry: 1,
    refetchInterval: (query) => {
      // No poll after an error (a 403 stays a 403) or for a finished path.
      const path = query.state.data && taskPathFrom(query.state.data, taskId!);
      if (!path || allTasksTerminal([...path.ancestors, path.task])) return false;
      return LIVE_PATH_POLL_MS;
    },
  });
}
