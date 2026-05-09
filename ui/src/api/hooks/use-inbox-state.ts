/**
 * Inbox-state (Phase 6 ≥1.76.0).
 *
 * Persists per-user dismiss/snooze/done decisions across devices via the
 * server-side `inbox_item_state` table — see plan section "Action-items inbox
 * (4 buckets, dismiss/snooze/done)" and migration 057.
 *
 * Race semantics for `useUpdateInboxItem` (TanStack flow per Phase 6 plan):
 *   - `onMutate`: snapshot the current `["inbox-state", userId]` cache, merge
 *     the new state in by `itemType+itemId` (Map-based), return the snapshot
 *     as a rollback ref.
 *   - `onError`: revert to snapshot, fire `toast.error`.
 *   - `onSettled`: invalidate so the next polling tick converges with the
 *     server.
 *
 * Polling-tick interaction: when `useInboxState` re-fetches, the `select`
 * function below (intentionally identity for now) keeps the server response.
 * Because every consumer reads the cache through TanStack's normal flow, an
 * optimistic mutation that's still in flight stays merged into the cache
 * until `onSettled` invalidates, at which point the server response (which
 * will include the persisted row) takes over. Multiple rapid dismisses
 * accumulate via successive `onMutate` calls into the same cache entry; the
 * PATCH calls execute in parallel; `onSettled` invalidations debounce via
 * TanStack's default coalescing.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../client";
import type { InboxItemState, InboxItemStatus, InboxItemType } from "../types";

export interface UseInboxStateOptions {
  userId: string | null | undefined;
  status?: InboxItemStatus;
  itemType?: InboxItemType;
}

export function useInboxState(options: UseInboxStateOptions) {
  const userId = options.userId ?? "";
  const status = options.status;
  const itemType = options.itemType;
  return useQuery<InboxItemState[]>({
    queryKey: ["inbox-state", userId, { status, itemType }],
    queryFn: () => api.listInboxState({ userId, status, itemType }),
    enabled: Boolean(userId),
  });
}

export interface UpdateInboxItemInput {
  userId: string;
  itemType: InboxItemType;
  itemId: string;
  status: InboxItemStatus;
  /** ISO 8601 datetime — required when `status === "snoozed"`. */
  snoozeUntil?: string;
}

interface MutationContext {
  /** Per-key rollback snapshots to revert on error. */
  snapshots: Array<{ key: ReadonlyArray<unknown>; previous: InboxItemState[] | undefined }>;
}

/**
 * Merge an optimistic row into a cached `InboxItemState[]` by
 * `itemType+itemId`. Returns a new array — does not mutate input.
 */
function mergeOptimistic(
  prev: InboxItemState[] | undefined,
  optimistic: InboxItemState,
): InboxItemState[] {
  const next: InboxItemState[] = [];
  let replaced = false;
  for (const row of prev ?? []) {
    if (row.itemType === optimistic.itemType && row.itemId === optimistic.itemId) {
      next.push(optimistic);
      replaced = true;
    } else {
      next.push(row);
    }
  }
  if (!replaced) next.push(optimistic);
  return next;
}

export function useUpdateInboxItem() {
  const queryClient = useQueryClient();

  return useMutation<InboxItemState, Error, UpdateInboxItemInput, MutationContext>({
    mutationFn: (input) => api.patchInboxState(input),
    onMutate: async (input) => {
      // Cancel in-flight refetches so they can't overwrite our optimistic
      // update before the server confirms it.
      await queryClient.cancelQueries({ queryKey: ["inbox-state", input.userId] });

      // Build the optimistic row — only `id`, `createdAt`, `lastUpdatedAt`
      // come back from the server, so we synthesize stable placeholders.
      const nowIso = new Date().toISOString();
      const optimistic: InboxItemState = {
        id: `optimistic:${input.itemType}:${input.itemId}`,
        userId: input.userId,
        itemType: input.itemType,
        itemId: input.itemId,
        status: input.status,
        snoozeUntil: input.snoozeUntil,
        dismissedAt: input.status === "dismissed" ? nowIso : undefined,
        doneAt: input.status === "done" ? nowIso : undefined,
        createdAt: nowIso,
        lastUpdatedAt: nowIso,
      };

      // Snapshot every cache entry under `["inbox-state", userId, …]` so we
      // can roll all of them back on error.
      const matches = queryClient.getQueriesData<InboxItemState[]>({
        queryKey: ["inbox-state", input.userId],
      });
      const snapshots: MutationContext["snapshots"] = matches.map(([key, previous]) => ({
        key,
        previous,
      }));

      for (const [key] of matches) {
        queryClient.setQueryData<InboxItemState[]>(key, (prev) =>
          mergeOptimistic(prev, optimistic),
        );
      }

      return { snapshots };
    },
    onError: (err, _input, context) => {
      if (context) {
        for (const { key, previous } of context.snapshots) {
          queryClient.setQueryData(key, previous);
        }
      }
      toast.error(err.message || "Failed to update inbox item");
    },
    onSettled: (_data, _err, input) => {
      queryClient.invalidateQueries({ queryKey: ["inbox-state", input.userId] });
    },
  });
}
