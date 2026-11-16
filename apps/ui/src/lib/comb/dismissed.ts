// Dismissed sends: the comments the connected person took out of the send
// tray ("Send N"). A dismissed comment stays on its file, drops out of the
// tray count, and is not sent. Restoring it puts it back.
//
// The list lives in localStorage, one key per swarm, agent-fs user, and
// drive, like Recently viewed (`recent.ts`).
// shortcut: per browser, not synced across devices; move it to agent-fs
// comment state if dismissals need to follow the user.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import type { DraftStorage } from "./drafts";
import type { Drive } from "./recent";

/** Ids the list keeps. The oldest drop first, so a full list never blocks a dismiss. */
export const DISMISSED_MAX = 2000;

/** The list's key: one per swarm (`apiUrl`), connected agent-fs user, and drive. */
export function dismissedStorageKey(apiUrl: string, userId: string, drive: Drive): string {
  return deriveStorageKey(apiUrl, `comb:dismissed-sends:${userId}:${drive.orgId}/${drive.driveId}`);
}

/** `list` with `ids` added at the end (newest last), each once, at most `max` long. */
export function withDismissed(
  list: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
  max = DISMISSED_MAX,
): string[] {
  const added = new Set(ids);
  return [...list.filter((id) => !added.has(id)), ...added].slice(-max);
}

/** `list` without `ids` (restored). */
export function withoutDismissed(
  list: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
): string[] {
  const restored = new Set(ids);
  return list.filter((id) => !restored.has(id));
}

/** The stored ids. Anything unreadable reads as an empty list. */
export function readDismissed(storage: DraftStorage | null, key: string): string[] {
  try {
    const raw = storage?.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string").slice(-DISMISSED_MAX);
  } catch {
    return [];
  }
}

export function writeDismissed(
  storage: DraftStorage | null,
  key: string,
  list: ReadonlyArray<string>,
): void {
  try {
    storage?.setItem(key, JSON.stringify(list));
  } catch {
    // A full or blocked localStorage only forgets the dismissals.
  }
}
