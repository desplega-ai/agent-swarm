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

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}
