import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import { api } from "../client";
import type { SessionMoveResult, SessionPrefixMoveResult } from "../types";
import { SESSION_TREE_KEY } from "./use-session-tree";

/** The server moves at most 200 sessions per call. */
const MOVE_BATCH = 200;

/** A move changes keys in the tree, the lists, and each moved session's detail. */
function invalidateAfterMove(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
  void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  void queryClient.invalidateQueries({ queryKey: ["session"] });
}

/**
 * Move sessions into a group (`groupKey`), or to no group (`null`). More
 * than 200 sessions go in batches. The result lists the moved sessions and
 * the skipped ones with the server's reason. A failure toasts the server's
 * message and refreshes the lists, so no stale state stays.
 */
export function useMoveSessions() {
  const queryClient = useQueryClient();
  return useMutation<SessionMoveResult, Error, { rootTaskIds: string[]; groupKey: string | null }>({
    mutationFn: async ({ rootTaskIds, groupKey }) => {
      const result: SessionMoveResult = { moved: [], skipped: [] };
      for (let i = 0; i < rootTaskIds.length; i += MOVE_BATCH) {
        const batch = await api.moveSessions(rootTaskIds.slice(i, i + MOVE_BATCH), groupKey);
        result.moved.push(...batch.moved);
        result.skipped.push(...batch.skipped);
      }
      return result;
    },
    onError: (error) =>
      toast.error(error.message || "Couldn't move the sessions", {
        position: SESSIONS_TOAST_POSITION,
      }),
    onSettled: () => invalidateAfterMove(queryClient),
  });
}

/**
 * Rename a group (`to` = the new key) or delete it (`to: null`, its sessions
 * go to no group). One call moves up to 200 sessions, so this repeats the
 * call while `remaining > 0`. Sessions the caller does not own stay, and the
 * result lists each of them once in `skipped`.
 */
export function useMovePrefix() {
  const queryClient = useQueryClient();
  return useMutation<SessionPrefixMoveResult, Error, { from: string; to: string | null }>({
    mutationFn: async ({ from, to }) => {
      const result: SessionPrefixMoveResult = { moved: [], skipped: [], remaining: 0 };
      const skippedIds = new Set<string>();
      let page: SessionPrefixMoveResult;
      do {
        page = await api.moveSessionPrefix(from, to);
        result.moved.push(...page.moved);
        // Skipped sessions stay in the range, so every call lists them again.
        for (const skip of page.skipped) {
          if (skippedIds.has(skip.rootTaskId)) continue;
          skippedIds.add(skip.rootTaskId);
          result.skipped.push(skip);
        }
        result.remaining = page.remaining;
        // `remaining` counts only sessions the caller can still move, so the
        // loop ends. A call that moves nothing also ends it, as a guard.
      } while (page.remaining > 0 && page.moved.length > 0);
      return result;
    },
    onError: (error) =>
      toast.error(error.message || "Couldn't move the group", {
        position: SESSIONS_TOAST_POSITION,
      }),
    onSettled: () => invalidateAfterMove(queryClient),
  });
}
