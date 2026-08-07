/**
 * DES-771: resolve the principal behind the configured bearer.
 *
 * Enabled only when the configured API key is a user-bound `aswt_` token
 * (embedded dashboards) — operator-key tabs keep the localStorage identity
 * picker. `api.whoami()` resolves `null` (never throws) on 404/network
 * failure, so `data === null` means "older server / unreachable" and the
 * caller falls back to the picker flow.
 *
 * The query key carries the apiUrl plus the token's last-4 suffix (the same
 * non-sensitive preview the server stores as `tokenPreview`) so a persisted
 * cache entry from one connection/token can't answer for another, without
 * ever writing the raw token into the persisted query cache.
 */

import { useQuery } from "@tanstack/react-query";
import { useConfig } from "@/hooks/use-config";
import { api } from "../client";

export function useWhoami(enabled: boolean) {
  const { config } = useConfig();
  return useQuery({
    queryKey: ["whoami", config.apiUrl, config.apiKey.slice(-4)],
    queryFn: () => api.whoami(),
    enabled,
    // The token→user binding is fixed for the life of the tab; no polling.
    refetchInterval: false,
  });
}
