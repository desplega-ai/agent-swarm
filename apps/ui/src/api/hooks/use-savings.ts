import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/** The server caches live savings for 10 minutes; match it here. */
export function useWorkflowSavings(workflowId: string | undefined) {
  return useQuery({
    queryKey: ["savings", "workflow", workflowId],
    queryFn: () => api.getWorkflowSavings(workflowId as string),
    enabled: !!workflowId,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useWorkflowSavingsDaily(workflowId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["savings", "workflow-daily", workflowId],
    queryFn: () => api.getWorkflowSavingsDaily(workflowId as string),
    enabled: !!workflowId && enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}
