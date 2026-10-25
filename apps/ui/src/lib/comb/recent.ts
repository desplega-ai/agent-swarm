// Recent files in Comb: the files this browser opened ("Recently viewed"),
// and the files that changed in the drive ("Recently changed", from the
// agent-fs `recent` op).
//
// Recently viewed lives in localStorage, one key per swarm, agent-fs user,
// and drive, namespaced by the swarm API URL like the other Comb keys. It
// never leaves the browser.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import type { RecentEntry } from "../agent-fs/types";
import { commentCombPath } from "./comments";
import type { DraftStorage } from "./drafts";
import { parentFolder } from "./paths";

/** Files the Recently viewed list keeps. */
export const VIEWED_MAX = 20;
/** Versions one `recent` call reads. Several versions of one file count once. */
export const RECENT_CHANGES_LIMIT = 50;

export interface ViewedFile {
  /** Drive path ("/docs/a.md"). */
  path: string;
  /** When the file was last opened (ms since epoch). */
  at: number;
}

export interface Drive {
  orgId: string;
  driveId: string;
}

/** The list's key: one per swarm (`apiUrl`), connected agent-fs user, and drive. */
export function viewedStorageKey(apiUrl: string, userId: string, drive: Drive): string {
  return deriveStorageKey(apiUrl, `comb:viewed:${userId}:${drive.orgId}/${drive.driveId}`);
}

/** `list` with `path` first (opened at `at`), without its older entry, at most `max` long. */
export function rememberViewed(
  list: ReadonlyArray<ViewedFile>,
  path: string,
  at: number,
  max = VIEWED_MAX,
): ViewedFile[] {
  return [{ path, at }, ...list.filter((entry) => entry.path !== path)].slice(0, max);
}

/** `list` without `path` (a file that is gone). */
export function forgetViewed(list: ReadonlyArray<ViewedFile>, path: string): ViewedFile[] {
  return list.filter((entry) => entry.path !== path);
}

/** The stored list, newest first. Anything unreadable reads as an empty list. */
export function readViewed(storage: DraftStorage | null, key: string): ViewedFile[] {
  try {
    const raw = storage?.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is ViewedFile =>
          typeof entry?.path === "string" &&
          entry.path.startsWith("/") &&
          typeof entry.at === "number",
      )
      .slice(0, VIEWED_MAX);
  } catch {
    return [];
  }
}

export function writeViewed(
  storage: DraftStorage | null,
  key: string,
  list: ReadonlyArray<ViewedFile>,
): void {
  try {
    storage?.setItem(key, JSON.stringify(list));
  } catch {
    // A full or blocked localStorage only forgets the list.
  }
}

export interface RecentChange {
  /** Drive path ("/docs/a.md"). */
  path: string;
  /** agent-fs user id of the newest version's writer. */
  author: string;
  /** ISO time of the newest version. */
  at: string;
}

/**
 * The newest version of each file, newest first, at most `max`. A file whose
 * newest version is a delete is left out (its older writes too), so a moved
 * or removed file does not show.
 */
export function recentChanges(entries: ReadonlyArray<RecentEntry>, max: number): RecentChange[] {
  const seen = new Set<string>();
  const changes: RecentChange[] = [];
  for (const entry of entries) {
    const path = commentCombPath(entry.path);
    if (path === "/" || seen.has(path)) continue;
    seen.add(path);
    if (entry.operation === "delete") continue;
    changes.push({ path, author: entry.author, at: entry.createdAt });
    if (changes.length >= max) break;
  }
  return changes;
}

/** Where a file sits, for the second line of a list row: "docs/plans", or "Drive root". */
export function folderLabel(path: string): string {
  const folder = parentFolder(path);
  return folder === "/" ? "Drive root" : folder.slice(1, -1);
}
