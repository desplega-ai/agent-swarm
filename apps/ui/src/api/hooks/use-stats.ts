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

/**
 * Steering feature flag, read from the authenticated `/api/stats` payload —
 * deliberately NOT from the unauthenticated `/health` endpoint (server config
 * must not leak there). Defaults to enabled so a newer UI remains compatible
 * with older API servers whose stats response lacks `steeringEnabled`; the
 * version feature-gate still hides steering UI against pre-steering servers.
 */
export function useSteeringEnabled() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => api.fetchStats(),
    refetchInterval: 30_000,
    retry: 2,
    retryDelay: 1000,
    staleTime: 30_000,
    select: (data) => data.steeringEnabled ?? true,
  });
}

export function useLogs(limit = 50, agentId?: string) {
  return useQuery({
    queryKey: ["logs", limit, agentId],
    queryFn: () => api.fetchLogs(limit, agentId),
    select: (data) => data.logs,
  });
}
