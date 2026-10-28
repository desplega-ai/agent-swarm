import { hashKey, type QueryKey, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  sessionsFilterParams,
  useSessionsShow,
  useSessionsShownSources,
} from "@/lib/sessions-show";
import { api } from "../client";

import type { SessionTreeResponse } from "../types";
import { sessionTreeKey } from "./session-query-keys";

/** The app's poll interval (`app/providers.tsx`). */
const SESSION_TREE_STALE_MS = 10_000;

/**
 * `placeholderData` for a Mine / All or source switch: the previous view's
 * tree stays on screen while the new one loads, for the same viewer only
 * (`["session-tree", userId, ...]`).
 */
function keepAcrossViews(key: QueryKey) {
  return (previous: SessionTreeResponse | undefined, previousQuery?: { queryKey: QueryKey }) =>
    previousQuery && hashKey(previousQuery.queryKey.slice(0, 2)) === hashKey(key.slice(0, 2))
      ? previous
      : undefined;
}

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
  const queryKey = sessionTreeKey(userId ?? null, show, shown);
  return useQuery({
    queryKey,
    queryFn: () => api.getSessionTree(sessionsFilterParams(show, shown)),
    enabled: options?.enabled ?? true,
    // Fresh for one poll: a reader that mounts later (the pane header's
    // labels on every session open) reuses the cache instead of refetching.
    staleTime: SESSION_TREE_STALE_MS,
    placeholderData: keepAcrossViews(queryKey),
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
