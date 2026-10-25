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

const NO_LABELS: Readonly<Record<string, string>> = {};

/**
 * The source group labels of the tree (`#eng`, `DM · Lena`), from the same
 * cache. Empty while it loads, and for a source the filter hides.
 */
export function useSessionLabels(): Readonly<Record<string, string>> {
  return useSessionTree().data?.labels ?? NO_LABELS;
}
