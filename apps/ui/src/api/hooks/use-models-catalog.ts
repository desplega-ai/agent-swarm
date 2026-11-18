import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api, type ModelsCatalogResponse } from "@/api/client";
import {
  loadModelsSnapshot,
  modelsSnapshot,
  subscribeModelsSnapshot,
} from "../../lib/models-snapshot";

/**
 * Live model catalog from `GET /api/models-catalog` — the server-side slim
 * projection of models.dev, refreshed by the pricing-refresh loop (boot +
 * every 12h). Consumers pass `data?.providers` into `modelGroupsForHarness`,
 * which falls back to the bundled snapshot while this is loading/errored. The
 * snapshot loads on first use (`useModelsSnapshot`), so a picker may show only
 * the registry sections until one of the two lands. The `refetchInterval`
 * keeps long-mounted tabs following the server-side refresh (staleTime alone
 * never schedules a request); it can be lazy since the upstream source only
 * moves twice a day.
 */
export function useModelsCatalog() {
  const snapshotLoaded = useModelsSnapshot();
  return useQuery({
    queryKey: ["models-catalog"],
    queryFn: () => api.fetchModelsCatalog(),
    // A new `providers` object once the snapshot lands, so memos and caches
    // keyed on it recompute with the snapshot sections merged in.
    select: snapshotLoaded ? withFreshProviders : undefined,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Starts loading the bundled models.dev snapshot (`lib/models-snapshot.ts`)
 * and re-renders the caller once it lands, so `agent-runtime-models` helpers
 * called during render read it. Returns whether it has loaded.
 */
export function useModelsSnapshot(): boolean {
  useEffect(() => {
    // A failed load leaves the registry sections and the live catalog.
    loadModelsSnapshot().catch(() => {});
  }, []);
  return useSyncExternalStore(subscribeModelsSnapshot, () => modelsSnapshot() !== null);
}

const freshProviders = new WeakMap<ModelsCatalogResponse, ModelsCatalogResponse>();

/** One copy per response, shared by every caller, so caches keyed on it still hit. */
function withFreshProviders(data: ModelsCatalogResponse): ModelsCatalogResponse {
  let fresh = freshProviders.get(data);
  if (!fresh) {
    fresh = { ...data, providers: { ...data.providers } };
    freshProviders.set(data, fresh);
  }
  return fresh;
}
