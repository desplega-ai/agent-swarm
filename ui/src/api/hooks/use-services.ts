import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export interface ServiceFilters {
  status?: string;
  agentId?: string;
  name?: string;
}

export function useServices(filters?: ServiceFilters) {
  return useQuery({
    queryKey: ["services", filters],
    queryFn: () => api.fetchServices(filters),
    select: (data) => data.services,
  });
}
