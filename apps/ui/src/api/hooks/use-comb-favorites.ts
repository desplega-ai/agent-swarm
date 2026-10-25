import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import { agentFsKey, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { useFavorites, useFavoriteToggle } from "@/api/hooks/use-favorites";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { type AgentFsClient, AgentFsError } from "@/lib/agent-fs/client";
import type { AgentFsFavorite, FavoriteListResult } from "@/lib/agent-fs/types";
import {
  dashboardPinsToMove,
  favoriteApiPath,
  favoritePinIds,
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

/**
 * Comb favorites. With an agent-fs that has the `favorites` feature, they are
 * the person's agent-fs stars, shared with the agent-fs live UI. Otherwise
 * they are the dashboard favorites (item type `agent-fs-path`), as before.
 * Dashboard stars on the drive move to agent-fs once it has stars.
 */
export function useCombFavorites(drive: Drive | null): CombFavorites {
  const { state, features } = useAgentFs();
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

  const starToggle = useMutation({
    mutationFn: ({ target, favorite }: { target: DrivePath; favorite: boolean }) =>
      (access.client as AgentFsClient).callOp(
        target.orgId,
        favorite ? "favorite-add" : "favorite-remove",
        { path: favoriteApiPath(target.path) },
        target.driveId,
      ),
    onMutate: async ({ target, favorite }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AgentFsFavorite[]>(key);
      queryClient.setQueryData<AgentFsFavorite[]>(key, (list) =>
        withFavorite(list ?? [], target.path, favorite, new Date().toISOString()),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => queryClient.setQueryData(key, context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  useMoveDashboardPins(
    onAgentFs && drive && stars.data && dashboard.data ? drive : null,
    dashboard.data?.favoriteIds ?? [],
    access.client,
    () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ["favorites", "agent-fs-path"] });
    },
  );

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

/** One move per agent-fs user and drive per page load, so a failing star is not retried in a loop. */
const moved = new Set<string>();

/**
 * Moves the dashboard stars on `drive` to agent-fs: each one is starred on
 * agent-fs, then dropped from the dashboard. A path that is gone (404) or
 * cannot be a star (the drive root, 400) is dropped too. Any other failure
 * keeps the dashboard star for the next page load.
 */
function useMoveDashboardPins(
  drive: Drive | null,
  dashboardIds: readonly string[],
  client: AgentFsClient | null,
  onDone: () => void,
) {
  const { credential } = useAgentFs();
  const pins = drive ? dashboardPinsToMove(dashboardIds, drive) : [];
  const runKey =
    drive && client && pins.length > 0
      ? `${client.endpoint}:${credential?.userId}:${drive.orgId}/${drive.driveId}`
      : null;
  // The latest pins and callback. `runKey` alone starts a move.
  const latest = useRef({ pins, onDone });
  latest.current = { pins, onDone };
  useEffect(() => {
    if (!runKey || !client || moved.has(runKey)) return;
    moved.add(runKey);
    const { pins: toMove, onDone: done } = latest.current;
    void (async () => {
      for (const pin of toMove) {
        try {
          await client.callOp(
            pin.orgId,
            "favorite-add",
            { path: favoriteApiPath(pin.path) },
            pin.driveId,
          );
        } catch (error) {
          const gone =
            error instanceof AgentFsError && (error.status === 404 || error.status === 400);
          if (!gone) continue;
        }
        try {
          await api.setFavorite({
            itemType: "agent-fs-path",
            itemId: pinIdFor(pin),
            favorite: false,
          });
        } catch {
          // The dashboard star stays. agent-fs already has it, so the next move only drops it.
        }
      }
      done();
    })();
  }, [runKey, client]);
}

/** Whether `target` is a star in `favorites`. */
export function isCombFavorite(favorites: CombFavorites, target: DrivePath): boolean {
  return favorites.ids?.includes(pinIdFor(target)) ?? false;
}
