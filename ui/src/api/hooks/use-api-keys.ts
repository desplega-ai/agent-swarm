import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export function useApiKeyStatuses(keyType?: string) {
  return useQuery({
    queryKey: ["api-key-statuses", keyType],
    queryFn: () => api.fetchApiKeyStatuses(keyType),
    select: (data) => data.keys,
  });
}

export function useApiKeyCosts(keyType?: string) {
  return useQuery({
    queryKey: ["api-key-costs", keyType],
    queryFn: () => api.fetchApiKeyCosts(keyType),
    select: (data) => data.costs,
  });
}

/** Set or clear the human-friendly label on a pooled credential. */
export function useSetApiKeyName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.setApiKeyName.bind(api),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-statuses"] });
    },
  });
}
