/**
 * Sessions surface (Phase 4 ≥1.76.0) — react-query bindings for the
 * `/api/sessions` endpoints.
 *
 * - `useSessions()` powers the `/sessions` sidebar list (root-task chains
 *   ordered by chain-wide last activity). Filter (`source`) and search
 *   (`q`) are pushed up to the API, so the UI never filters in memory. The
 *   data is one page (`sessions`, `total`, `limit`, `offset`).
 * - `useSession(rootTaskId)` returns the full chain payload for the
 *   selected session.
 *
 * Soft-degrade: callers must wrap usage in `useFeatureGate("1.76.0")` so
 * older API servers (which 404 these endpoints) don't render the surface.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/current-user-context";
import { sessionSharesMutationOptions } from "@/lib/session-shares-mutation";
import { sharesInput } from "@/lib/session-sharing";
import { sessionRefetchInterval } from "@/lib/task-activity";
import { api } from "../client";
import type { SessionStatusFilter, SessionTriageFilter } from "../types";

export interface UseSessionsOptions {
  limit?: number;
  offset?: number;
  /** Source filter (e.g. `["ui"]`). Empty / undefined → all sources. */
  source?: string[];
  /** Case-insensitive substring search against the root task's text. */
  q?: string;
  /** When set, restrict results to sessions owned by this user. */
  requestedByUserId?: string;
  /** Root tasks whose `contextKey` starts with this prefix (≥1.157.1). */
  contextKeyPrefix?: string;
  /**
   * `mine` / `shared` (session sharing servers only, see `SESSION_SHARING_MIN_VERSION`).
   * Every sessions v2 list sends `tree`, so its totals match `useSessionTree()`.
   */
  scope?: "mine" | "shared" | "tree";
  /** Asset key prefix, subgroups included (sessions v2). */
  keyPrefix?: string;
  /** Exactly this group, not its subgroups (sessions v2). */
  groupKey?: string;
  /** Sessions in no group (sessions v2). */
  noGroup?: boolean;
  /** Read-state section: Inbox, Later, Done, or every unread session (sessions v2). */
  triage?: SessionTriageFilter;
  /** Running, failed, or "Needs you" (sessions v2). */
  status?: SessionStatusFilter;
  /** A person in the chain or a share user (sessions v2). */
  withUserId?: string;
  /** Disable the query entirely (e.g. when user identity is not yet resolved). */
  enabled?: boolean;
}

/**
 * Query key prefix of every session list page. The triage hooks patch rows
 * under it. Invalidate with `["sessions"]`.
 */
export const SESSION_LIST_KEY = ["sessions", "list"] as const;

export function useSessions(options?: UseSessionsOptions) {
  const { enabled = true, ...rest } = options ?? {};
  const params = { ...rest, limit: rest.limit ?? 50 };
  // Rows carry the viewer's read state, and `scope` and `triage` depend on
  // the viewer, so a user switch must not show the last user's page.
  const { userId } = useCurrentUser();
  return useQuery({
    queryKey: [...SESSION_LIST_KEY, userId ?? null, params],
    queryFn: () => api.listSessions(params),
    enabled,
  });
}

/** The HTTP status a failed session fetch carried (403: no access). */
export function sessionErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

export function useSession(rootTaskId: string | undefined) {
  return useQuery({
    queryKey: ["session", rootTaskId],
    queryFn: () => api.getSession(rootTaskId!),
    enabled: !!rootTaskId,
    // A 403 does not get better with retries; it changes when the owner shares.
    retry: (failureCount, error) => sessionErrorStatus(error) !== 403 && failureCount < 3,
    // Replaces the app-wide 10s default: 4s while any task is active so live
    // progress keeps up, back to 10s once the chain settles (never stops).
    refetchInterval: (query) => sessionRefetchInterval(query.state.data),
  });
}

/**
 * Active shares of a session. `data === null` means the API predates session
 * sharing (404): hide the Share button.
 */
export function useSessionShares(rootTaskId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["session-shares", rootTaskId],
    queryFn: () => api.getSessionShares(rootTaskId!),
    enabled: !!rootTaskId && enabled,
  });
}

/** Apply a full share state. Optimistic: the dialog shows the change at once. */
export function useUpdateSessionShares(rootTaskId: string) {
  const queryClient = useQueryClient();
  return useMutation(
    sessionSharesMutationOptions(
      queryClient,
      rootTaskId,
      (next) => api.putSessionShares(rootTaskId, sharesInput(next)),
      (error) => toast.error(error instanceof Error ? error.message : "Couldn't update sharing"),
    ),
  );
}

/** Set (non-empty string) or clear (`null`) a session's custom display title. */
export function useUpdateSessionTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string | null }) =>
      api.updateTaskTitle(id, title),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["session", task.id] });
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
}
