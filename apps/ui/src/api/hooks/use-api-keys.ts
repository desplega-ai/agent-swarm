import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { ApiKeyStatusResponse, UsageSummaryResponse } from "../types";

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

/** Clear a pooled credential's active rate-limit record. */
export function useClearApiKeyRateLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.clearApiKeyRateLimit.bind(api),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-statuses"] });
    },
  });
}

/** Subscription plans and their monthly list prices. The catalog is static per server build. */
export function useSubscriptionPlans() {
  return useQuery({
    queryKey: ["subscription-plans"],
    queryFn: () => api.fetchSubscriptionPlans(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
}

/**
 * Set or clear the subscription plan of a pooled credential. The usage
 * summary and the key list are polled, so a GET that started before the
 * write is cancelled and the cached rows take the new plan at once. The
 * refetch then brings the server's view (for `plan: null`, the detected or
 * estimated plan).
 */
export function useSetApiKeyPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: Parameters<typeof api.setApiKeyPlan>[0]) => api.setApiKeyPlan(args),
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["usage-summary"] }),
        queryClient.cancelQueries({ queryKey: ["api-key-statuses"] }),
      ]);
    },
    onSuccess: (_result, { keyType, keySuffix, plan }) => {
      const planSource = plan ? ("manual" as const) : null;
      const patch = <T extends { keyType: string | null; keySuffix: string | null }>(row: T) =>
        row.keyType === keyType && row.keySuffix === keySuffix ? { ...row, plan, planSource } : row;
      queryClient.setQueriesData<UsageSummaryResponse>({ queryKey: ["usage-summary"] }, (data) =>
        data?.byCredential ? { ...data, byCredential: data.byCredential.map(patch) } : data,
      );
      queryClient.setQueriesData<ApiKeyStatusResponse>(
        { queryKey: ["api-key-statuses"] },
        (data) => (data ? { ...data, keys: data.keys.map(patch) } : data),
      );
      queryClient.invalidateQueries({ queryKey: ["usage-summary"] });
      queryClient.invalidateQueries({ queryKey: ["api-key-statuses"] });
    },
  });
}
