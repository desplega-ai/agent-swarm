import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export interface ConfigFilters {
  scope?: string;
  scopeId?: string;
  includeSecrets?: boolean;
}

export function useConfigs(filters?: ConfigFilters) {
  return useQuery({
    queryKey: ["configs", filters],
    queryFn: () => api.fetchConfigs(filters),
    select: (data) => data.configs,
  });
}

export function useUpsertConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      scope: string;
      scopeId?: string | null;
      key: string;
      value: string;
      isSecret?: boolean;
      envPath?: string | null;
      description?: string | null;
    }) => api.upsertConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
  });
}

export function useDeleteConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteConfig(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
  });
}
