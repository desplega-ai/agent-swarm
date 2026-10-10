import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../client";
import type { FavoriteItemType } from "../types";
import { patchFavoriteFlag } from "./favorite-flag";

const ENTITY_QUERY_KEYS: Record<FavoriteItemType, string[]> = {
  page: ["pages", "page"],
  workflow: ["workflows", "workflow"],
  schedule: ["scheduled-tasks", "scheduled-task"],
  // Comb pins: no entity list carries a favorite flag.
  "agent-fs-path": [],
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

type FavoriteSnapshot = [readonly unknown[], unknown][];

export function useFavoriteToggle(itemType: FavoriteItemType) {
  const queryClient = useQueryClient();
  const entityKeys = ENTITY_QUERY_KEYS[itemType];
  return useMutation({
    mutationFn: ({ itemId, favorite }: { itemId: string; favorite: boolean }) =>
      api.setFavorite({ itemType, itemId, favorite }),
    // Entity stars flip at once. A list poll that lands mid-flight would
    // overwrite the flip with the old flag, so cancel those first.
    onMutate: async ({ itemId, favorite }): Promise<{ snapshot: FavoriteSnapshot }> => {
      const snapshot: FavoriteSnapshot = [];
      for (const key of entityKeys) {
        await queryClient.cancelQueries({ queryKey: [key] });
        for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: [key] })) {
          snapshot.push([queryKey, data]);
          queryClient.setQueryData(queryKey, patchFavoriteFlag(data, itemId, favorite));
        }
      }
      return { snapshot };
    },
    onError: (_error, { favorite }, context) => {
      for (const [queryKey, data] of context?.snapshot ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
      // Pins toast their own wording ("Could not pin.").
      if (entityKeys.length > 0) {
        toast.error(favorite ? "Could not add favorite." : "Could not remove favorite.");
      }
    },
    onSettled: () => {
      for (const key of entityKeys) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      // Returned, so the mutation stays pending until the favorites list is
      // fresh. Pin stars read that list, so they never flicker back.
      return queryClient.invalidateQueries({ queryKey: ["favorites", itemType] });
    },
  });
}
