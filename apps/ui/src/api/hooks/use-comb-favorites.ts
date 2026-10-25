import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/api/client";
import { agentFsKey, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { useFavorites, useFavoriteToggle } from "@/api/hooks/use-favorites";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { type AgentFsClient, AgentFsError } from "@/lib/agent-fs/client";
import type { AgentFsFavorite, FavoriteListResult } from "@/lib/agent-fs/types";
import { browserStorage } from "@/lib/comb/drafts";
import {
  favoriteApiPath,
  favoritePinIds,
  favoritesImportKey,
  starsToImport,
  withFavorite,
} from "@/lib/comb/favorites";
import { type DrivePath, pinIdFor } from "@/lib/comb/paths";

type Drive = { orgId: string; driveId: string };

/** The Comb stars of one drive, from agent-fs or (older agent-fs) the dashboard. */
export interface CombFavorites {
  /** Pin ids (`pinIdFor`), newest first. Undefined while loading. */
  ids: string[] | undefined;
  isPending: boolean;
  error: Error | null;
  /** False when no store answers (hide the stars). */
  available: boolean;
  /** Star or unstar `target`. `onError` runs after the list rolls back. */
  toggle: (target: DrivePath, favorite: boolean, options?: { onError?: () => void }) => void;
  isToggling: boolean;
}

/** Star toggles in flight per favorites query (see `useCombFavorites`). */
const inFlight = new Map<string, number>();

function bumpInFlight(key: readonly unknown[], delta: 1 | -1): number {
  const id = JSON.stringify(key);
  const next = Math.max(0, (inFlight.get(id) ?? 0) + delta);
  if (next === 0) inFlight.delete(id);
  else inFlight.set(id, next);
  return next;
}

/** Imports started in this page load, so a failing star is not retried in a loop. */
const importing = new Set<string>();

/**
 * Comb favorites. With an agent-fs that has the `favorites` feature, they are
 * the person's agent-fs stars, shared with the agent-fs live UI. Otherwise
 * they are the dashboard favorites (item type `agent-fs-path`), as before.
 *
 * The dashboard stars on the drive are imported into agent-fs once per
 * browser and agent-fs account (a marker in localStorage). The import copies:
 * the dashboard keeps its stars, so an agent-fs without the feature, or a
 * browser that is not connected, still lists them.
 */
export function useCombFavorites(drive: Drive | null): CombFavorites {
  const { state, features } = useAgentFs();
  const { apiUrl } = useConfig().config;
  const access = useAgentFsAccess();
  const queryClient = useQueryClient();
  const onAgentFs = state === "ready" && features.has("favorites") && access.client !== null;

  const dashboard = useFavorites("agent-fs-path");
  const dashboardToggle = useFavoriteToggle("agent-fs-path");

  const key = agentFsKey(
    access.endpoint,
    access.userId,
    drive?.orgId ?? null,
    drive?.driveId ?? null,
    "favorites",
  );
  const stars = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      (
        await (access.client as AgentFsClient).callOp<FavoriteListResult>(
          drive?.orgId as string,
          "favorite-list",
          {},
          drive?.driveId,
          { signal },
        )
      ).favorites,
    enabled: onAgentFs && drive !== null,
    staleTime: 30_000,
  });

  // Each toggle patches only its own star, so a failure rolls back that star
  // and no other. The list refetches once the last toggle settles: an
  // earlier refetch could bring back the old state of a toggle still in flight.
  const starToggle = useMutation({
    mutationFn: ({ target, favorite }: { target: DrivePath; favorite: boolean }) =>
      (access.client as AgentFsClient).callOp(
        target.orgId,
        favorite ? "favorite-add" : "favorite-remove",
        { path: favoriteApiPath(target.path) },
        target.driveId,
      ),
    onMutate: async ({ target, favorite }) => {
      bumpInFlight(key, 1);
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<AgentFsFavorite[]>(key, (list) =>
        withFavorite(list ?? [], target.path, favorite, new Date().toISOString()),
      );
    },
    onError: (_error, { target, favorite }) =>
      queryClient.setQueryData<AgentFsFavorite[]>(key, (list) =>
        withFavorite(list ?? [], target.path, !favorite, new Date().toISOString()),
      ),
    onSettled: () => {
      if (bumpInFlight(key, -1) > 0) return;
      return queryClient.invalidateQueries({ queryKey: key });
    },
  });

  // The one-time import of the dashboard stars. It reads both lists fresh
  // from the servers: the query cache is persisted, so cached lists can be
  // older than the servers, and the import would mark itself done too early.
  const userId = access.userId;
  const client = access.client;
  const orgId = drive?.orgId;
  const driveId = drive?.driveId;
  const keyId = JSON.stringify(key);
  useEffect(() => {
    if (!onAgentFs || !orgId || !driveId || !client || !userId) return;
    const target = { orgId, driveId };
    const marker = deriveStorageKey(apiUrl, favoritesImportKey(client.endpoint, userId, target));
    if (importing.has(marker) || readImported(marker)) return;
    importing.add(marker);
    void (async () => {
      let complete = true;
      let added = 0;
      try {
        const [dashboardList, starList] = await Promise.all([
          api.listFavorites({ itemType: "agent-fs-path" }),
          client.callOp<FavoriteListResult>(orgId, "favorite-list", {}, driveId),
        ]);
        for (const pin of starsToImport(dashboardList.favoriteIds, starList.favorites, target)) {
          try {
            await client.callOp(
              orgId,
              "favorite-add",
              { path: favoriteApiPath(pin.path) },
              driveId,
            );
            added++;
          } catch (error) {
            // A path that is gone (404) or cannot be a star (400) is skipped.
            const skip =
              error instanceof AgentFsError && (error.status === 404 || error.status === 400);
            if (!skip) complete = false;
          }
        }
      } catch {
        complete = false;
      }
      // A failure (network, 5xx) leaves the marker unset: the next page load tries again.
      if (complete) writeImported(marker);
      if (added > 0) void queryClient.invalidateQueries({ queryKey: JSON.parse(keyId) });
    })();
  }, [onAgentFs, orgId, driveId, client, userId, apiUrl, queryClient, keyId]);

  if (onAgentFs && drive) {
    return {
      ids: stars.data ? favoritePinIds(stars.data, drive) : undefined,
      isPending: stars.isPending,
      error: stars.error,
      available: !(stars.isError && !stars.data),
      toggle: (target, favorite, options) =>
        starToggle.mutate({ target, favorite }, { onError: options?.onError }),
      isToggling: starToggle.isPending,
    };
  }
  return {
    ids: dashboard.data?.favoriteIds,
    isPending: dashboard.isPending,
    error: dashboard.error,
    // An API without pins rejects the item type.
    available: !(dashboard.isError && !dashboard.data),
    toggle: (target, favorite, options) =>
      dashboardToggle.mutate({ itemId: pinIdFor(target), favorite }, { onError: options?.onError }),
    isToggling: dashboardToggle.isPending,
  };
}

function readImported(marker: string): boolean {
  try {
    return (browserStorage()?.getItem(marker) ?? null) !== null;
  } catch {
    return false;
  }
}

function writeImported(marker: string) {
  try {
    browserStorage()?.setItem(marker, new Date().toISOString());
  } catch {
    // Blocked storage: the import runs again on the next page load (adding a star twice is a no-op).
  }
}

/** Whether `target` is a star in `favorites`. */
export function isCombFavorite(favorites: CombFavorites, target: DrivePath): boolean {
  return favorites.ids?.includes(pinIdFor(target)) ?? false;
}
