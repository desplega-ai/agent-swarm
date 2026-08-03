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
 * One named query as the runtime wants it run: the query name plus, for a
 * query with `{ "$param": … }` filters, the route params to resolve them with.
 * `enabled: false` parks a query whose params aren't all in the route yet — the
 * runtime fills that slot with an explicit "missing route param(s)" error.
 */
export interface AppQueryPlan {
  name: string;
  params?: Record<string, string | number | boolean>;
  enabled?: boolean;
}

/**
 * Runs every named query of an app definition in parallel on the standard 5s
 * poll. Returns the react-query results in the same order as `plans`.
 *
 * Parameterized queries carry their params in the query key (so two routes
 * cache separately) — `appQueryKey` stays the shared PREFIX, which is what the
 * `refetchQuery` / `refetchModel` invalidations match on.
 */
export function useAppQueries(appId: string, plans: AppQueryPlan[]) {
  return useQueries({
    queries: plans.map((plan) => ({
      queryKey: plan.params
        ? ([...appQueryKey(appId, plan.name), plan.params] as const)
        : appQueryKey(appId, plan.name),
      queryFn: () => api.runAppQuery(appId, plan.name, plan.params),
      refetchInterval: 5000,
      enabled: plan.enabled ?? true,
    })),
  });
}

/**
 * Manual "Refresh" for `/apps/:id`: re-reads the app definition AND every one
 * of its named queries. The definition itself only polls every 30s, so this is
 * what an operator reaches for right after an agent re-upserts the app.
 */
export function useAppRefresh(appId: string) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["app", appId] }),
      queryClient.invalidateQueries({ queryKey: ["app-query", appId] }),
    ]);
  }, [appId, queryClient]);
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
