// Sessions v2: a new group has no sessions, so the server does not know it
// yet. It lives in this browser until a session moves in (plan D8). After
// that the session keys are the truth.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SessionTreeGroup } from "../api/types";

/** The local groups the server does not have yet, as zero-count tree groups after the server's. */
export function withEmptyGroups(
  groups: SessionTreeGroup[],
  local: readonly string[],
): SessionTreeGroup[] {
  const known = new Set(groups.map((group) => group.key));
  const extra = local
    .filter((key) => !known.has(key))
    .map((key) => ({ key, total: 0, unread: 0, running: 0, needsYou: 0, lastActivityAt: "" }));
  return extra.length > 0 ? [...groups, ...extra] : groups;
}

/** A local group is done once the server has it, or a group inside it. */
export function stillEmpty(local: readonly string[], serverKeys: readonly string[]): string[] {
  return local.filter((key) => !serverKeys.some((server) => server.startsWith(key)));
}

// One store for every hook instance in this tab, plus the `storage` event
// for other tabs, so a group made in the move dialog shows in the Start in
// picker at once.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readRaw(storageKey: string): string {
  try {
    return localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function parseKeys(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function writeKeys(storageKey: string, keys: string[]) {
  try {
    if (keys.length > 0) localStorage.setItem(storageKey, JSON.stringify(keys));
    else localStorage.removeItem(storageKey);
  } catch {
    // Storage off: the group shows until a reload.
  }
  for (const listener of listeners) listener();
}

export interface EmptyGroups {
  /** The local group keys, in the order they were made. */
  keys: string[];
  add: (key: string) => void;
  /** A group rename: every local key under `from` moves under `to`. */
  rename: (from: string, to: string) => void;
  /** A group delete: every local key under `prefix` goes. */
  remove: (prefix: string) => void;
  /** Drop the groups the server now has (call it in an effect). */
  prune: (serverKeys: readonly string[]) => void;
}

/**
 * The empty groups of this browser, per connection and per user (the
 * dashboard can switch swarms and users).
 */
export function useEmptyGroups(apiUrl: string, me: string | null): EmptyGroups {
  const storageKey = `agent-swarm-sessions-v2-empty-groups:${apiUrl}:${me ?? "operator"}`;
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(storageKey),
    () => "",
  );
  const keys = useMemo(() => parseKeys(raw), [raw]);
  const update = useCallback(
    (change: (keys: string[]) => string[]) => {
      const before = parseKeys(readRaw(storageKey));
      const after = [...new Set(change(before))];
      if (after.length !== before.length || after.some((key, i) => key !== before[i])) {
        writeKeys(storageKey, after);
      }
    },
    [storageKey],
  );
  return useMemo(
    () => ({
      keys,
      add: (key) => update((prev) => [...prev, key]),
      rename: (from, to) =>
        update((prev) =>
          prev.map((key) => (key.startsWith(from) ? to + key.slice(from.length) : key)),
        ),
      remove: (prefix) => update((prev) => prev.filter((key) => !key.startsWith(prefix))),
      prune: (serverKeys) => update((prev) => stillEmpty(prev, serverKeys)),
    }),
    [keys, update],
  );
}
