import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/contexts/current-user-context";
import { api } from "../client";

/** Query key prefix of the sessions v2 tree. Invalidate with this key. */
export const SESSION_TREE_KEY = ["session-tree"] as const;

/**
 * Every visible session group with its counts, plus the Inbox, Later, Done,
 * and No group counts (`GET /api/session-tree`). The counts are per viewer,
 * so the key holds the picked user. It polls on the app default.
 */
export function useSessionTree(options?: { enabled?: boolean }) {
  const { userId } = useCurrentUser();
  return useQuery({
    queryKey: [...SESSION_TREE_KEY, userId ?? null],
    queryFn: () => api.getSessionTree(),
    enabled: options?.enabled ?? true,
  });
}
