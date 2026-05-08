import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { ProviderName } from "../types";

/**
 * Identity + setup + activity + agent_fs payload from `GET /status`.
 *
 * Phase 1: no built-in polling — consumers explicitly request a refetch
 * (e.g. after `POST /status/test-connection`) or rely on the default
 * react-query 5s staleTime. Phase 2 will expose a `pollIntervalMs` option
 * driven by the Page Visibility API.
 */
export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.fetchStatus(),
    retry: 2,
    retryDelay: 1000,
  });
}

export function useTestConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderName) => api.testConnection(provider),
    onSuccess: () => {
      // Refresh /status so the harness milestone flips to `verified`.
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
