import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export function useWorkflows() {
  return useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.fetchWorkflows(),
    select: (data) => data.workflows,
  });
}

export function useWorkflow(id: string) {
  return useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.fetchWorkflow(id),
    enabled: !!id,
  });
}

export function useWorkflowRuns(workflowId: string) {
  return useQuery({
    queryKey: ["workflow-runs", workflowId],
    queryFn: () => api.fetchWorkflowRuns(workflowId),
    enabled: !!workflowId,
  });
}

export function useAllWorkflowRuns() {
  return useQuery({
    queryKey: ["workflow-runs-all"],
    queryFn: () => api.fetchAllWorkflowRuns(),
  });
}

export function useWorkflowRun(id: string) {
  return useQuery({
    queryKey: ["workflow-run", id],
    queryFn: () => api.fetchWorkflowRun(id),
    enabled: !!id,
  });
}

export function useUpdateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<{ name: string; description: string; enabled: boolean }>;
    }) => api.updateWorkflow(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.invalidateQueries({ queryKey: ["workflow"] });
    },
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
}

export function useTriggerWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, triggerData }: { id: string; triggerData?: Record<string, unknown> }) =>
      api.triggerWorkflow(id, triggerData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
      queryClient.invalidateQueries({ queryKey: ["workflow-runs-all"] });
    },
  });
}

export function useWorkflowVersions(workflowId: string) {
  return useQuery({
    queryKey: ["workflow-versions", workflowId],
    queryFn: () => api.fetchWorkflowVersions(workflowId),
    enabled: !!workflowId,
  });
}

export function useExecutorType(type: string) {
  return useQuery({
    queryKey: ["executor-type", type],
    queryFn: () => api.fetchExecutorType(type),
    enabled: !!type,
    staleTime: 60_000, // schemas don't change at runtime
  });
}

export function useRetryWorkflowRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.retryWorkflowRun(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
      queryClient.invalidateQueries({ queryKey: ["workflow-runs-all"] });
      queryClient.invalidateQueries({ queryKey: ["workflow-run"] });
    },
  });
}
