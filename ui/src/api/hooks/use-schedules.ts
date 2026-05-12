import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { ScheduledTask } from "../types";

export interface ScheduledTaskFilters {
  enabled?: boolean;
  name?: string;
}

export function useScheduledTasks(filters?: ScheduledTaskFilters) {
  return useQuery({
    queryKey: ["scheduled-tasks", filters],
    queryFn: () => api.fetchScheduledTasks(filters),
    select: (data) => data.scheduledTasks,
  });
}

export function useScheduledTask(id: string) {
  return useQuery({
    queryKey: ["scheduled-task", id],
    queryFn: () => api.fetchSchedule(id),
    enabled: !!id,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      taskTemplate: string;
      cronExpression?: string;
      intervalMs?: number;
      description?: string;
      taskType?: string;
      tags?: string[];
      priority?: number;
      targetAgentId?: string;
      timezone?: string;
      model?: string;
      enabled?: boolean;
    }) => api.createSchedule(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ScheduledTask> }) =>
      api.updateSchedule(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["scheduled-task"] });
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
  });
}

export function useRunScheduleNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runScheduleNow(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["scheduled-task"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
