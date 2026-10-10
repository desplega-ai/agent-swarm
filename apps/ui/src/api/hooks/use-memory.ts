import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { MemoryListRequest } from "../types";

export function useMemoryList(params: MemoryListRequest, enabled = true) {
  return useQuery({
    queryKey: ["memory", params],
    queryFn: () => api.listMemory(params),
    enabled,
    refetchOnWindowFocus: false,
  });
}

/** Keyed memories under `prefix`, one aggregate row per memory. */
export function useMemoryKeys(prefix: string, enabled = true) {
  return useQuery({
    queryKey: ["memory", "keys", prefix],
    queryFn: () => api.listMemoryKeys(prefix),
    enabled,
    refetchOnWindowFocus: false,
  });
}

/** Every chunk of the memory that `memoryId` belongs to. */
export function useMemoryChunks(memoryId: string | null) {
  return useQuery({
    queryKey: ["memory", "chunks", memoryId],
    queryFn: () => api.getMemoryChunks(memoryId as string),
    enabled: !!memoryId,
    refetchOnWindowFocus: false,
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}
