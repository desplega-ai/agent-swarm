import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/**
 * Registered lifecycle edge handlers (with embedded aggregate stats) powering
 * the read-only `/routing` lifecycle map. Read-only surface — no mutations.
 */
export function useRoutingHandlers() {
  return useQuery({
    queryKey: ["routing", "handlers"],
    queryFn: () => api.fetchRoutingHandlers(),
  });
}

/**
 * Per-handler routing statistics, optionally scoped to a trailing window of
 * `windowHours`. The `/routing` page relies on the stats embedded in
 * `useRoutingHandlers`; this hook is here for parity with the standalone
 * `GET /api/routing/stats` endpoint.
 */
export function useRoutingStats(windowHours?: number) {
  return useQuery({
    queryKey: ["routing", "stats", windowHours ?? null],
    queryFn: () => api.fetchRoutingStats(windowHours),
  });
}
