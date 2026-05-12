import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => api.fetchStats(),
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.checkHealth(),
    refetchInterval: 10000,
    retry: 2,
    retryDelay: 1000,
  });
}

/**
 * Selector wrapping `useHealth().data?.version` for the feature-gate machinery.
 *
 * `staleTime: 30_000` (NOT `Infinity`) covers the "API server upgraded under a
 * long-lived UI tab" case: 30s is fast enough to react to a version bump and
 * slow enough to avoid hot polling. Reuses the existing `["health"]` query key
 * so we don't pay for a second fetch.
 */
export function useApiVersion() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.checkHealth(),
    refetchInterval: 10000,
    retry: 2,
    retryDelay: 1000,
    staleTime: 30_000,
    select: (data) => data.version,
  });
}

export function useLogs(limit = 50, agentId?: string) {
  return useQuery({
    queryKey: ["logs", limit, agentId],
    queryFn: () => api.fetchLogs(limit, agentId),
    select: (data) => data.logs,
  });
}
