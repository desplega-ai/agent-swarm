import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export interface TaskFilters {
  status?: string;
  agentId?: string;
  epicId?: string;
  search?: string;
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
