import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/**
 * Windowed memory usefulness analytics from `GET /api/memory/usefulness`
 * (memory-retrieval-v2 Phase 1 readout).
 *
 * Graceful degradation: `api.fetchMemoryUsefulness()` returns `null` for any
 * non-2xx response — older API servers predate this route and 404. The
 * /memory page treats `null`/`undefined` as "no data" and hides the whole
 * Usefulness panel, so the query never surfaces an error state.
 *
 * No polling — this is a windowed aggregate over the measurement tables, not
 * live state; a 60s `staleTime` keeps repeat visits cheap.
 */
export function useMemoryUsefulness(days = 30) {
  return useQuery({
    queryKey: ["memory-usefulness", days],
    queryFn: () => api.fetchMemoryUsefulness(days),
    staleTime: 60_000,
    // Never noisy-retry against an API server that simply lacks the route.
    retry: false,
  });
}
