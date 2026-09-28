import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/**
 * What each model tier resolves to per harness provider, from
 * `GET /api/models-catalog/tiers`. The server resolves `latest:` aliases
 * against the live catalog and reads the effective `MODEL_TIER_<PROVIDER>_<TIER>`
 * value, so the Configuration page previews the same answer a claim would get.
 * A saved tier value only takes effect on the server's debounced config reload,
 * so the query polls while the Configuration page is open.
 */
export function useModelTiers() {
  return useQuery({
    queryKey: ["models-catalog", "tiers"],
    queryFn: async () => (await api.fetchModelTiers()).tiers,
    staleTime: 5 * 1000,
    refetchInterval: 15 * 1000,
  });
}
