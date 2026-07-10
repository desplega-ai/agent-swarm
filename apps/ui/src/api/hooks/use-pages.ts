import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import { fetchAllPages } from "../fetch-all-pages";

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

/**
 * Complete page catalog for list surfaces that apply client-side predicates.
 * The API caps each request, so walk its offset pagination until every row in
 * the reported result set has been loaded.
 */
export function useAllPages(filters?: Pick<PagesFilters, "agentId">) {
  return useQuery({
    queryKey: ["pages", "all", filters],
    queryFn: () => fetchAllPages((batch) => api.listPages(batch), filters),
    refetchInterval: 5000,
  });
}

/**
 * Single-page lookup via the bearer-authed `/api/pages/:id` endpoint —
 * works for any authMode (returns title/slug/description/etc.). Used by
 * breadcrumbs + the detail-page sidebar where we want the title without
 * minting a page-session cookie.
 */
export function usePage(id: string | undefined) {
  return useQuery({
    queryKey: ["page", id],
    queryFn: () => api.getPage(id ?? ""),
    enabled: !!id,
    staleTime: 30_000,
  });
}
