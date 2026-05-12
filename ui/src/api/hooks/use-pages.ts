import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export interface PagesFilters {
  agentId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Bearer-authed listing of DB-backed pages. 5s polling matches the default
 * pattern used by other list hooks; pages mutate rarely so the cost is
 * negligible.
 */
export function usePages(filters?: PagesFilters) {
  return useQuery({
    queryKey: ["pages", filters],
    queryFn: () => api.listPages(filters),
    refetchInterval: 5000,
  });
}
