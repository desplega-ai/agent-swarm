// Comb favorites on agent-fs (`favorite-list`, `favorite-add`, `favorite-remove`,
// feature `favorites`), the same stars as the agent-fs live UI. Comb lists
// them as pin ids (`pinIdFor`), newest first, like the dashboard favorites it
// used before, so the lists and the sidebar keep one shape.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentFsFavorite } from "../agent-fs/types";
import { type DrivePath, parsePinId, pinIdFor } from "./paths";

type Drive = { orgId: string; driveId: string };

/** The Comb drive path of a star: a folder ends with "/". */
export function favoriteCombPath(favorite: Pick<AgentFsFavorite, "path" | "kind">): string {
  const path = `/${favorite.path.replace(/^\/+|\/+$/g, "")}`;
  return favorite.kind === "directory" && path !== "/" ? `${path}/` : path;
}

/** The agent-fs path of a Comb drive path: no trailing "/". */
export function favoriteApiPath(combPath: string): string {
  return `/${combPath.replace(/^\/+|\/+$/g, "")}`;
}

/** The stars as pin ids on `drive`, newest first. */
export function favoritePinIds(favorites: readonly AgentFsFavorite[], drive: Drive): string[] {
  return [...favorites]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.path.localeCompare(b.path))
    .map((favorite) => pinIdFor({ ...drive, path: favoriteCombPath(favorite) }));
}

/** The list after starring or unstarring `combPath` (the optimistic update). */
export function withFavorite(
  favorites: readonly AgentFsFavorite[],
  combPath: string,
  favorite: boolean,
  now: string,
): AgentFsFavorite[] {
  const path = favoriteApiPath(combPath);
  const rest = favorites.filter((entry) => entry.path !== path);
  if (!favorite) return rest;
  const kind = combPath.endsWith("/") ? "directory" : "file";
  return [{ path, kind, createdAt: now }, ...rest];
}

/** The dashboard pins on `drive` that move to agent-fs (Comb used them before agent-fs had stars). */
export function dashboardPinsToMove(ids: readonly string[], drive: Drive): DrivePath[] {
  return ids
    .map(parsePinId)
    .filter(
      (pin): pin is DrivePath =>
        pin !== null && pin.orgId === drive.orgId && pin.driveId === drive.driveId,
    );
}
