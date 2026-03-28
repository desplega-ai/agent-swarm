import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export interface TaskFilters {
  status?: string;
  agentId?: string;
  scheduleId?: string;
  search?: string;
  includeHeartbeat?: boolean;
  limit?: number;
  offset?: number;
}

export function useTasks(filters?: TaskFilters) {
  return useQuery({
    queryKey: ["tasks", filters],
    queryFn: () => api.fetchTasks(filters),
    select: (data) => ({ tasks: data.tasks, total: data.total }),
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.fetchTask(id),
    enabled: !!id,
  });
}

export function useTaskSessionLogs(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId, "session-logs"],
    queryFn: () => api.fetchTaskSessionLogs(taskId),
    enabled: !!taskId,
    refetchInterval: 5000,
  });
}

export function useTaskContext(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId, "context"],
    queryFn: () => api.fetchTaskContext(taskId),
    enabled: !!taskId,
    refetchInterval: 10000,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      task: string;
      agentId?: string;
      taskType?: string;
      tags?: string[];
      priority?: number;
      dependsOn?: string[];
    }) => api.createTask(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.cancelTask(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

export function usePauseTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.pauseTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
    },
  });
}

export function useResumeTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.resumeTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task"] });
    },
  });
}
