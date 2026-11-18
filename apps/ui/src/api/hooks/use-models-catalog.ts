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
 * which falls back to the bundled snapshot for every section it lacks. The
 * `refetchInterval` keeps long-mounted tabs following the server-side refresh
 * (staleTime alone never schedules a request); it can be lazy since the
 * upstream source only moves twice a day.
 *
 * The snapshot loads on first use (`useModelsSnapshot`), so a picker may show
 * only the registry sections until it lands. When it lands, `data.providers`
 * becomes a new object, also with no live response yet (an empty, snapshot-only
 * catalog), so every memo, dial cache and default keyed on it recomputes with
 * the snapshot sections merged in. The copy is made here, not in `select`:
 * React Query's structural sharing would hand back the previous object.
 * `snapshotLoaded` tells a caller that drops values the catalog does not list
 * to wait for it.
 */
export function useModelsCatalog() {
  const snapshotLoaded = useModelsSnapshot();
  const query = useQuery({
    queryKey: ["models-catalog"],
    queryFn: () => api.fetchModelsCatalog(),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const data = snapshotLoaded ? withSnapshot(query.data) : query.data;
  return { ...query, data, snapshotLoaded };
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

/** No live response (loading or failed): every section comes from the snapshot. */
const SNAPSHOT_ONLY: ModelsCatalogResponse = { source: "snapshot", updatedAt: null, providers: {} };

const withSnapshotByResponse = new WeakMap<ModelsCatalogResponse, ModelsCatalogResponse>();

/** One copy per response, shared by every caller, so caches keyed on it still hit. */
function withSnapshot(data: ModelsCatalogResponse | undefined): ModelsCatalogResponse {
  if (!data) return SNAPSHOT_ONLY;
  let fresh = withSnapshotByResponse.get(data);
  if (!fresh) {
    fresh = { ...data, providers: { ...data.providers } };
    withSnapshotByResponse.set(data, fresh);
  }
  return fresh;
}
