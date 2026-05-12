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
  /** Phase 2 (≥1.76.0): ISO 8601 timestamp; backend filters createdAt >= value. */
  createdAfter?: string;
  /** Filter to tasks whose `source` is in this list. Empty/undefined → all. */
  source?: string[];
}

export function useTasks(filters?: TaskFilters) {
  return useQuery({
    queryKey: ["tasks", filters],
    queryFn: () => api.fetchTasks(filters),
    select: (data) => ({ tasks: data.tasks, total: data.total }),
  });
}

export function useTask(id: string, opts?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.fetchTask(id),
    enabled: !!id,
    refetchInterval: opts?.refetchInterval,
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
      /** Phase 3 (≥1.76.0): parent task for grouped/parallel sub-tasks. */
      parentTaskId?: string;
      /** Phase 3 (≥1.76.0): override the wire `source` ("api"|"mcp"|"slack"). */
      source?: string;
      /** Phase 3 (≥1.76.0): identity of the requesting user. */
      requestedByUserId?: string;
      /** Phase 3 (≥1.76.0): cross-ingress conversation/thread context key. */
      contextKey?: string;
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
