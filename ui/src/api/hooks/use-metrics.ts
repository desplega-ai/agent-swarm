import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/**
 * Swarm-wide COUNT(*) metrics from `GET /api/metrics`.
 *
 * Graceful degradation: `api.fetchMetrics()` returns `null` for any non-2xx
 * response — older API servers predate this route and 404. Consumers (the
 * sidebar indicators) treat `null`/`undefined` as "no data" and render
 * nothing, so the query never throws and never surfaces an error state.
 *
 * 5s polling matches the default list-hook cadence; the payload is a handful
 * of cheap counts so the cost is negligible.
 *
 * `opts.enabled` lets feature-gated callers suppress the query entirely on
 * older API servers — pass `false` until the gate confirms support.
 */
export function useMetrics(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: () => api.fetchMetrics(),
    refetchInterval: 5000,
    enabled: opts?.enabled ?? true,
    // Never noisy-retry against an API server that simply lacks the route.
    retry: false,
  });
}
