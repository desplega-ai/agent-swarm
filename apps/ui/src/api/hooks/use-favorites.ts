import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { FavoriteItemType } from "../types";

const ENTITY_QUERY_KEYS: Record<FavoriteItemType, string[]> = {
  page: ["pages", "page"],
  workflow: ["workflows", "workflow"],
  schedule: ["scheduled-tasks", "scheduled-task"],
  // Comb pins: no entity list carries a favorite flag.
  "agent-fs-path": [],
};

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

export function useFavoriteToggle(itemType: FavoriteItemType) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, favorite }: { itemId: string; favorite: boolean }) =>
      api.setFavorite({ itemType, itemId, favorite }),
    onSuccess: () => {
      for (const key of ENTITY_QUERY_KEYS[itemType]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      // Returned, so the mutation stays pending until the favorites list is
      // fresh. A star then never flips back for one render.
      return queryClient.invalidateQueries({ queryKey: ["favorites", itemType] });
    },
  });
}
