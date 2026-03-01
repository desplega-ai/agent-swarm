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

export function useLogs(limit = 50, agentId?: string) {
  return useQuery({
    queryKey: ["logs", limit, agentId],
    queryFn: () => api.fetchLogs(limit, agentId),
    select: (data) => data.logs,
  });
}
