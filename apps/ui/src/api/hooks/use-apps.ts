import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../client";
import type { AppDefinition } from "../types";

/** Query key for one resolved named query of a swarm app. */
export function appQueryKey(appId: string, queryName: string) {
  return ["app-query", appId, queryName] as const;
}

/** App catalog for `/apps`. 5s polling matches the dashboard default. */
export function useApps() {
  return useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: 5000,
  });
}

/**
 * App definition for `/apps/:id`. Polled slowly (30s): the definition only
 * changes when an agent re-upserts the app, while the *data* refresh comes
 * from `useAppQueries` below.
 */
export function useApp(id: string | undefined) {
  return useQuery({
    queryKey: ["app", id],
    queryFn: () => api.getApp(id ?? ""),
    enabled: !!id,
    refetchInterval: 30_000,
  });
}

/**
 * Runs every named query of an app definition in parallel on the standard 5s
 * poll. Returns the react-query results in the same order as `queryNames`.
 */
export function useAppQueries(appId: string, queryNames: string[]) {
  return useQueries({
    queries: queryNames.map((name) => ({
      queryKey: appQueryKey(appId, name),
      queryFn: () => api.runAppQuery(appId, name),
      refetchInterval: 5000,
    })),
  });
}

/**
 * Imperative refetch helpers used by the `app.mutate` / `app.refresh`
 * actions. `refetchModel` re-runs every named query whose `model` matches the
 * mutated model, so a create/update/delete is reflected without waiting for
 * the next poll tick.
 */
export function useAppQueryRefetch(appId: string, definition: AppDefinition | undefined) {
  const queryClient = useQueryClient();

  const refetchQuery = useCallback(
    async (queryName?: string) => {
      if (queryName) {
        await queryClient.invalidateQueries({ queryKey: appQueryKey(appId, queryName) });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["app-query", appId] });
    },
    [appId, queryClient],
  );

  const refetchModel = useCallback(
    async (model: string) => {
      const entries = Object.entries(definition?.queries ?? {});
      const names = entries.filter(([, def]) => def.model === model).map(([name]) => name);
      await Promise.all(
        names.map((name) => queryClient.invalidateQueries({ queryKey: appQueryKey(appId, name) })),
      );
    },
    [appId, definition, queryClient],
  );

  return { refetchQuery, refetchModel };
}
