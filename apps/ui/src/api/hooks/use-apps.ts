import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../client";
import type { AppDefinition, AppUserConfigValue } from "../types";

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

/** Query key for one app's per-viewer userConfig values. */
export function appUserConfigKey(appId: string) {
  return ["app-user-config", appId] as const;
}

/**
 * This viewer's merged `userConfig` values (+ the declaring schema) for one
 * app. Polled at the definition cadence (30s), not the data cadence: these are
 * per-user preferences that only change when this dashboard writes them, and
 * the settings drawer invalidates the key on save.
 *
 * `enabled` lets a caller skip the request entirely for an app that declares no
 * `userConfig` — the route answers `{values:{},schema:{}}` for those, so the
 * call is merely pointless, never wrong.
 */
export function useAppUserConfig(appId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: appUserConfigKey(appId ?? ""),
    queryFn: () => api.getAppUserConfig(appId ?? ""),
    enabled: !!appId && (options?.enabled ?? true),
    refetchInterval: 30_000,
  });
}

/**
 * Save this viewer's preferences for one app. The PUT replaces the stored
 * values wholesale and answers with the freshly merged view, which is written
 * straight into the cache so the surface's `/user/<field>` mirror updates on
 * the same tick; the invalidate then reconciles with the server.
 */
export function useSaveAppUserConfig(appId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, AppUserConfigValue>) => api.putAppUserConfig(appId, values),
    onSuccess: (data) => {
      queryClient.setQueryData(appUserConfigKey(appId), data);
      void queryClient.invalidateQueries({ queryKey: appUserConfigKey(appId) });
    },
  });
}

/**
 * One named query as the runtime wants it run: the OWNING app, the query name
 * and, for a query with `{ "$param": … }` filters, the route params to resolve
 * them with. `enabled: false` parks a query whose params aren't all in the
 * route yet — the runtime fills that slot with an explicit "missing route
 * param(s)" error.
 *
 * `appId` is per-plan (not per-hook) because one surface runs its OWN queries
 * alongside the queries of every app it borrows a bound element from. The keys
 * stay `appId`-keyed, so two surfaces reading the same app still share one
 * fetch and one liveness cadence.
 */
export interface AppQueryPlan {
  appId: string;
  name: string;
  params?: Record<string, string | number | boolean>;
  enabled?: boolean;
}

/**
 * Runs a flat list of named queries in parallel on the standard 5s poll.
 * Returns the react-query results in the same order as `plans`.
 *
 * Parameterized queries carry their params in the query key (so two routes
 * cache separately) — `appQueryKey` stays the shared PREFIX, which is what the
 * `refetchQuery` / `refetchModel` invalidations match on.
 */
export function useAppQueries(plans: AppQueryPlan[]) {
  return useQueries({
    queries: plans.map((plan) => ({
      queryKey: plan.params
        ? ([...appQueryKey(plan.appId, plan.name), plan.params] as const)
        : appQueryKey(plan.appId, plan.name),
      queryFn: () => api.runAppQuery(plan.appId, plan.name, plan.params),
      refetchInterval: 5000,
      enabled: plan.enabled ?? true,
    })),
  });
}

/**
 * Definitions of the apps a surface borrows elements from, in `appIds` order.
 *
 * ONE `useQueries` over the whole list — a `useApp()` per target would make
 * the hook count vary with the app definition (Rules of Hooks). Same key and
 * cadence as `useApp`, so a borrowed app that is also open in another tab of
 * the dashboard resolves from the same cache entry.
 */
export function useAppDefinitions(appIds: string[]) {
  return useQueries({
    queries: appIds.map((appId) => ({
      queryKey: ["app", appId] as const,
      queryFn: () => api.getApp(appId),
      refetchInterval: 30_000,
    })),
  });
}

/**
 * Manual "Refresh" for `/apps/:id`: re-reads the app definition AND every one
 * of its named queries. The definition itself only polls every 30s, so this is
 * what an operator reaches for right after an agent re-upserts the app.
 *
 * Takes EVERY app on the surface — its own plus the ones it borrows elements
 * from — so an embed refreshes with the page it is embedded in (both the
 * borrowed definition and the data behind it).
 */
export function useAppRefresh(appIds: string[]) {
  const queryClient = useQueryClient();
  // Serialized: `appIds` is a fresh array on every render of the caller.
  const key = appIds.join(",");
  return useCallback(async () => {
    await Promise.all(
      key
        .split(",")
        .filter(Boolean)
        .flatMap((appId) => [
          queryClient.invalidateQueries({ queryKey: ["app", appId] }),
          queryClient.invalidateQueries({ queryKey: ["app-query", appId] }),
        ]),
    );
  }, [key, queryClient]);
}

/**
 * Imperative refetch helpers used by the `app.mutate` / `app.refresh`
 * actions. `refetchModel` re-runs every named query whose `model` matches the
 * mutated model, so a create/update/delete is reflected without waiting for
 * the next poll tick.
 *
 * `definitions` maps every app the surface currently runs queries for (its own
 * plus the apps it borrows bound elements from) to that app's definition, so
 * an action invoked from inside a borrowed element refreshes the DEFINING
 * app's queries.
 */
export function useAppQueryRefetch(definitions: ReadonlyMap<string, AppDefinition>) {
  const queryClient = useQueryClient();

  const refetchQuery = useCallback(
    async (appId: string, queryName?: string) => {
      if (queryName) {
        await queryClient.invalidateQueries({ queryKey: appQueryKey(appId, queryName) });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["app-query", appId] });
    },
    [queryClient],
  );

  const refetchModel = useCallback(
    async (appId: string, model: string) => {
      const entries = Object.entries(definitions.get(appId)?.queries ?? {});
      const names = entries.filter(([, def]) => def.model === model).map(([name]) => name);
      await Promise.all(
        names.map((name) => queryClient.invalidateQueries({ queryKey: appQueryKey(appId, name) })),
      );
    },
    [definitions, queryClient],
  );

  /** Every app on this surface — a script action can touch any of them. */
  const refetchAll = useCallback(async () => {
    await Promise.all(
      [...definitions.keys()].map((appId) =>
        queryClient.invalidateQueries({ queryKey: ["app-query", appId] }),
      ),
    );
  }, [definitions, queryClient]);

  return { refetchQuery, refetchModel, refetchAll };
}
