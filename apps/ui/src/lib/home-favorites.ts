// Favorites on Home: where each starred item opens, and its kind label.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { FavoriteItemType, UserFavorite } from "../api/types";
import { combPath, isFolderPath, parsePinId } from "./comb/paths";
import { groupViewHref } from "./in-progress";

/** The dashboard route of a favorite. Null for an agent-fs pin id that does not parse. */
export function favoriteHref(itemType: FavoriteItemType, itemId: string): string | null {
  switch (itemType) {
    case "key":
      return groupViewHref(itemId);
    case "page":
      return `/pages/${encodeURIComponent(itemId)}`;
    case "workflow":
      return `/workflows/${encodeURIComponent(itemId)}`;
    case "schedule":
      return `/schedules/${encodeURIComponent(itemId)}`;
    case "agent-fs-path": {
      const pin = parsePinId(itemId);
      return pin ? combPath(pin) : null;
    }
    case "session":
      return `/sessions/${encodeURIComponent(itemId)}`;
    // A hidden group is a sidebar flag, not a favorite Home lists.
    case "hidden-key":
      return null;
  }
}

/** The kind column of a favorite row. */
export function favoriteKind(itemType: FavoriteItemType, itemId: string): string {
  switch (itemType) {
    case "key":
      return "Use case";
    case "page":
      return "Page";
    case "workflow":
      return "Workflow";
    case "schedule":
      return "Schedule";
    case "agent-fs-path":
      return isFolderPath(itemId) ? "Folder" : "File";
    case "session":
      return "Session";
    case "hidden-key":
      return "Hidden group";
  }
}

/** The favorites of every type in one list, newest star first. */
export function mergeFavorites(lists: ReadonlyArray<UserFavorite[] | undefined>): UserFavorite[] {
  return lists
    .flatMap((list) => list ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.itemId.localeCompare(b.itemId));
}
