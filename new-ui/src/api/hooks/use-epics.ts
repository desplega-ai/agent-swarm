import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

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
