import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { api } from "../client";
import type { FavoriteItemType } from "../types";
import { patchFavoriteFlag, readFavoriteFlag } from "./favorite-flag";

const ENTITY_QUERY_KEYS: Record<FavoriteItemType, string[]> = {
  page: ["pages", "page"],
  workflow: ["workflows", "workflow"],
  schedule: ["scheduled-tasks", "scheduled-task"],
  // Comb pins: no entity list carries a favorite flag.
  "agent-fs-path": [],
  // Starred Sessions groups: read from the favorites list only.
  key: [],
  // Starred sessions and hidden Sessions groups: read from the favorites list only.
  session: [],
  "hidden-key": [],
};

/**
 * Refetch everything that carries a favorite flag. Favorites belong to the
 * picked dashboard user, so a user switch must not keep showing the previous
 * user's stars.
 */
export function invalidateFavoriteQueries(queryClient: QueryClient) {
  for (const key of ["favorites", ...Object.values(ENTITY_QUERY_KEYS).flat()]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export function useFavorites(
  itemType: FavoriteItemType,
  itemIds?: string[],
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["favorites", itemType, itemIds],
    queryFn: () => api.listFavorites({ itemType, itemIds }),
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  });
}

/** The flag each cached query held for the item before the optimistic flip. */
type PreviousFlags = [readonly unknown[], boolean][];

/**
 * In-flight toggles per client and item type. Counted by hand, not with
 * `isMutating`, because a settling mutation still reads as pending, so two
 * toggles that settle together would each see the other and both skip the
 * refetch.
 */
const inFlightToggles = new WeakMap<QueryClient, Map<FavoriteItemType, number>>();

function bumpInFlight(queryClient: QueryClient, itemType: FavoriteItemType, delta: 1 | -1) {
  let counts = inFlightToggles.get(queryClient);
  if (!counts) {
    counts = new Map();
    inFlightToggles.set(queryClient, counts);
  }
  const next = Math.max(0, (counts.get(itemType) ?? 0) + delta);
  counts.set(itemType, next);
  return next;
}

/** Mutation options behind `useFavoriteToggle`, exported for tests. */
export function favoriteToggleOptions(queryClient: QueryClient, itemType: FavoriteItemType) {
  const entityKeys = ENTITY_QUERY_KEYS[itemType];
  return mutationOptions({
    mutationFn: ({ itemId, favorite }: { itemId: string; favorite: boolean }) =>
      api.setFavorite({ itemType, itemId, favorite }),
    // Entity stars flip at once. A list poll that lands mid-flight would
    // overwrite the flip with the old flag, so cancel those first.
    onMutate: async ({ itemId, favorite }): Promise<{ previous: PreviousFlags }> => {
      bumpInFlight(queryClient, itemType, 1);
      const previous: PreviousFlags = [];
      for (const key of entityKeys) {
        await queryClient.cancelQueries({ queryKey: [key] });
        for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: [key] })) {
          const flag = readFavoriteFlag(data, itemId);
          if (flag === undefined) continue;
          previous.push([queryKey, flag]);
          queryClient.setQueryData(queryKey, patchFavoriteFlag(data, itemId, favorite));
        }
      }
      return { previous };
    },
    // Roll back only this item, on the current cache, so other toggles still
    // in flight keep their flips. Skip a query whose flag no longer shows this
    // flip: a later toggle of the same item owns it now.
    onError: (_error, { itemId, favorite }, context) => {
      for (const [queryKey, flag] of context?.previous ?? []) {
        const data = queryClient.getQueryData(queryKey);
        if (readFavoriteFlag(data, itemId) !== favorite) continue;
        queryClient.setQueryData(queryKey, patchFavoriteFlag(data, itemId, flag));
      }
      // Pins toast their own wording ("Could not pin.").
      if (entityKeys.length > 0) {
        toast.error(favorite ? "Could not add favorite." : "Could not remove favorite.");
      }
    },
    // Refetch only after the last toggle settles. An earlier refetch would
    // overwrite the optimistic flag of a toggle that is still pending.
    onSettled: () => {
      if (bumpInFlight(queryClient, itemType, -1) > 0) return;
      for (const key of entityKeys) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      // Returned, so the mutation stays pending until the favorites list is
      // fresh. Pin stars read that list, so they never flicker back.
      return queryClient.invalidateQueries({ queryKey: ["favorites", itemType] });
    },
  });
}

export function useFavoriteToggle(itemType: FavoriteItemType) {
  const queryClient = useQueryClient();
  return useMutation(favoriteToggleOptions(queryClient, itemType));
}

/**
 * One flag of one item in the favorites list: a Sessions group star (`key`),
 * a session star (`session`), or a hidden group (`hidden-key`). Every flag of
 * a type reads one shared list. While a toggle is in flight the flag shows
 * the new state, and a failed toggle toasts. `null` (no item) reads nothing.
 */
export function useItemFavorite(
  itemType: "key" | "session" | "hidden-key",
  itemId: string | null,
  failure: { on: string; off: string } = { on: "Could not star.", off: "Could not unstar." },
) {
  const list = useFavorites(itemType, undefined, { enabled: itemId !== null });
  const toggle = useFavoriteToggle(itemType);
  const pending = toggle.isPending && toggle.variables?.itemId === itemId;
  const favorite = pending
    ? Boolean(toggle.variables?.favorite)
    : itemId !== null && (list.data?.favoriteIds.includes(itemId) ?? false);
  return {
    favorite,
    disabled: itemId === null || !list.data,
    toggle: () => {
      if (itemId === null) return;
      const next = !favorite;
      toggle.mutate(
        { itemId, favorite: next },
        { onError: () => toast.error(next ? failure.on : failure.off) },
      );
    },
  };
}

/** The star of a Sessions group (a `key` favorite). */
export function useKeyFavorite(groupKey: string | null) {
  return useItemFavorite("key", groupKey);
}

/** The star of one session (a `session` favorite, by root task id). */
export function useSessionFavorite(rootTaskId: string | null) {
  return useItemFavorite("session", rootTaskId);
}

const HIDE_FAILURE = { on: "Could not hide the group.", off: "Could not show the group." };

/** Whether a Sessions group is hidden from the sidebar (a `hidden-key` row). */
export function useHiddenGroup(groupKey: string | null) {
  return useItemFavorite("hidden-key", groupKey, HIDE_FAILURE);
}

/**
 * The ids of one favorites list as a set, for the sidebar rows: starred
 * groups (`key`), starred sessions (`session`), hidden groups (`hidden-key`).
 * Empty while the list loads. An in-flight toggle shows its new state.
 */
export function useFavoriteIdSet(itemType: "key" | "session" | "hidden-key"): ReadonlySet<string> {
  const list = useFavorites(itemType);
  const toggle = useFavoriteToggle(itemType);
  const ids = list.data?.favoriteIds;
  const variables = toggle.isPending ? toggle.variables : undefined;
  return useMemo(() => {
    const set = new Set(ids ?? []);
    if (variables) {
      if (variables.favorite) set.add(variables.itemId);
      else set.delete(variables.itemId);
    }
    return set;
  }, [ids, variables]);
}
