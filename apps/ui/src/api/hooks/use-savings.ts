import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/** Savings come from an hourly rollup; 10 minutes is fresh enough. */
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

/** Saving of every workflow over the last 30 days, for the workflows list. */
export function useWorkflowsSavings() {
  return useQuery({
    queryKey: ["savings", "workflows"],
    queryFn: () => api.getWorkflowsSavings({ days: 30 }),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}
