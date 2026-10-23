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
import { useSessionsFilter } from "@/lib/sessions-show";
import { sessionRefetchInterval } from "@/lib/task-activity";
import { api } from "../client";
import {
  sessionDetailKey,
  sessionListKey,
  sessionListParams,
  type UseSessionsOptions,
} from "./session-query-keys";

export {
  SESSION_LIST_KEY,
  type SessionListParams,
  sessionDetailKey,
  sessionListParamsOf,
  type UseSessionsOptions,
} from "./session-query-keys";

/**
 * The query of one session list page. `useSessions` uses it, and so does a
 * view that loads several lists at once (`useQueries`), so both share one
 * cache entry per page.
 */
export function sessionsQueryOptions(userId: string | null, options?: UseSessionsOptions) {
  const params = sessionListParams(options);
  return {
    queryKey: sessionListKey(userId, params),
    queryFn: () => api.listSessions(params),
    enabled: options?.enabled ?? true,
  };
}

export function useSessions(options?: UseSessionsOptions) {
  const { userId } = useCurrentUser();
  useSessionsFilter();
  return useQuery(sessionsQueryOptions(userId ?? null, options));
}

/** The HTTP status a failed session fetch carried (403: no access). */
export function sessionErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A tab in the background polls its session this often (sessions v2 tab strip). */
const BACKGROUND_SESSION_POLL_MS = 30_000;

/**
 * How a `useSession` caller polls. `pane` (the default): 4s while a task is
 * active, else 10s. `background`: every 30s, for a tab that needs only its
 * title and state. `off`: no timer of its own, for a reader of a session
 * that a pane or a tab already polls (each observer runs its own timer).
 */
export type SessionPoll = "pane" | "background" | "off";

export function useSession(rootTaskId: string | undefined, options?: { poll?: SessionPoll }) {
  // The detail carries the viewer's access and read state, so it is cached
  // per dashboard user: after a switch of user, the pane shows that user's
  // access and read state, never the cached one of the previous user.
  // Read-on-open keys its once-per-open mark by user too.
  const { userId } = useCurrentUser();
  const poll = options?.poll ?? "pane";
  return useQuery({
    queryKey: sessionDetailKey(rootTaskId, userId ?? null),
    queryFn: () => api.getSession(rootTaskId!),
    enabled: !!rootTaskId,
    // A 403 does not get better with retries; it changes when the owner shares.
    retry: (failureCount, error) => sessionErrorStatus(error) !== 403 && failureCount < 3,
    // Replaces the app-wide 10s default: 4s while any task is active so live
    // progress keeps up, back to 10s once the chain settles (never stops).
    refetchInterval: (query) =>
      poll === "off"
        ? false
        : poll === "background"
          ? BACKGROUND_SESSION_POLL_MS
          : sessionRefetchInterval(query.state.data),
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
