import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

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
