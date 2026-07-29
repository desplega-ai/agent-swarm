import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/**
 * Live model catalog from `GET /api/models-catalog` — the server-side slim
 * projection of models.dev, refreshed by the pricing-refresh loop (boot +
 * every 12h). Consumers pass `data?.providers` into `modelGroupsForHarness`,
 * which falls back to the bundled snapshot while this is loading/errored, so
 * the model picker is never blank. The `refetchInterval` keeps long-mounted
 * tabs following the server-side refresh (staleTime alone never schedules a
 * request); it can be lazy since the upstream source only moves twice a day.
 */
export function useModelsCatalog() {
  return useQuery({
    queryKey: ["models-catalog"],
    queryFn: () => api.fetchModelsCatalog(),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
