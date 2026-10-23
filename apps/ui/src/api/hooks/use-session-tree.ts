import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  sessionsFilterParams,
  useSessionsShow,
  useSessionsShownSources,
} from "@/lib/sessions-show";
import { api } from "../client";

import { sessionTreeKey } from "./session-query-keys";

export { SESSION_TREE_KEY } from "./session-query-keys";

/**
 * Every visible session group with its counts, plus the Inbox, Later, Done,
 * and No group counts (`GET /api/session-tree`). The counts are per viewer,
 * so the key holds the picked user and the filter (Mine / All, shown
 * sources). It polls on the app default.
 */
export function useSessionTree(options?: { enabled?: boolean }) {
  const { userId } = useCurrentUser();
  const [show] = useSessionsShow();
  const [shown] = useSessionsShownSources();
  return useQuery({
    queryKey: sessionTreeKey(userId ?? null, show, shown),
    queryFn: () => api.getSessionTree(sessionsFilterParams(show, shown)),
    enabled: options?.enabled ?? true,
  });
}
