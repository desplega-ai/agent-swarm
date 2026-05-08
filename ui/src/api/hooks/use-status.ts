import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../client";
import type { ProviderName } from "../types";

/**
 * Identity + setup + activity + agent_fs payload from `GET /status`.
 *
 * Phase 2: Accepts `pollIntervalMs` (default 30s). Polling pauses while the
 * tab is hidden via the Page Visibility API and resumes on `visibilitychange`.
 *
 * Most consumers should NOT call this directly — use `useStatusContext()` from
 * `app/status-context.tsx` so multiple components share one fetch instead of
 * each spawning its own polling loop.
 */
export function useStatus(options?: { pollIntervalMs?: number }) {
  const intervalMs = options?.pollIntervalMs ?? 30_000;
  const isVisible = useDocumentVisible();

  return useQuery({
    queryKey: ["status"],
    queryFn: () => api.fetchStatus(),
    retry: 2,
    retryDelay: 1000,
    // `false` disables polling entirely; otherwise return the interval. Hidden
    // tabs pause to save bandwidth on a per-tab basis.
    refetchInterval: intervalMs > 0 && isVisible ? intervalMs : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Returns `true` when `document.visibilityState === 'visible'` (or in
 * environments without the API). Re-renders on `visibilitychange`.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return visible;
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
