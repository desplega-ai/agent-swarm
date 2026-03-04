import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { Epic } from "../types";

export interface EpicFilters {
  status?: string;
  search?: string;
  leadAgentId?: string;
}

export function useEpics(filters?: EpicFilters) {
  return useQuery({
    queryKey: ["epics", filters],
    queryFn: () => api.fetchEpics(filters),
    select: (data) => ({ epics: data.epics, total: data.total }),
  });
}

export function useEpic(id: string) {
  return useQuery({
    queryKey: ["epic", id],
    queryFn: () => api.fetchEpic(id),
    enabled: !!id,
  });
}

export function useCreateEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      goal: string;
      description?: string;
      priority?: number;
      tags?: string[];
      leadAgentId?: string;
    }) => api.createEpic(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["epics"] });
    },
  });
}

export function useUpdateEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Epic> }) => api.updateEpic(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["epics"] });
      queryClient.invalidateQueries({ queryKey: ["epic"] });
    },
  });
}

export function useDeleteEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEpic(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["epics"] });
    },
  });
}

export function useAssignTaskToEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ epicId, data }: { epicId: string; data: { taskId?: string; task?: string } }) =>
      api.assignTaskToEpic(epicId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["epic"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
