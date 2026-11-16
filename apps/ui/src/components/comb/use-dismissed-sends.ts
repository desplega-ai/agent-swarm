import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { useConfig } from "@/hooks/use-config";
import {
  dismissedStorageKey,
  readDismissed,
  withDismissed,
  withoutDismissed,
  writeDismissed,
} from "@/lib/comb/dismissed";
import { browserStorage } from "@/lib/comb/drafts";
import type { Drive } from "@/lib/comb/recent";

// This browser's dismissed sends (`lib/comb/dismissed.ts`), one list per
// swarm, connected agent-fs user, and drive. One snapshot per storage key, so
// `useSyncExternalStore` gets the same array until the list changes. Another
// tab's change arrives as a `storage` event.

const NONE: string[] = [];
const snapshots = new Map<string, string[]>();
const listeners = new Set<() => void>();

function snapshot(key: string): string[] {
  let list = snapshots.get(key);
  if (!list) {
    list = readDismissed(browserStorage(), key);
    snapshots.set(key, list);
  }
  return list;
}

function update(key: string, list: string[]) {
  snapshots.set(key, list);
  writeDismissed(browserStorage(), key, list);
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === null || !snapshots.has(event.key)) return;
  snapshots.delete(event.key);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export interface DismissedSends {
  /** Comment ids the connected person dismissed from the send tray. */
  ids: ReadonlySet<string>;
  dismiss: (ids: readonly string[]) => void;
  restore: (ids: readonly string[]) => void;
}

/** The connected person's dismissed sends on `drive`. Empty and inert while Comb is not connected. */
export function useDismissedSends(drive: Drive): DismissedSends {
  const { apiUrl } = useConfig().config;
  const { userId } = useAgentFsAccess();
  const key = userId ? dismissedStorageKey(apiUrl, userId, drive) : null;
  const list = useSyncExternalStore(
    subscribe,
    () => (key ? snapshot(key) : NONE),
    () => NONE,
  );
  const ids = useMemo(() => new Set(list), [list]);
  const dismiss = useCallback(
    (dismissed: readonly string[]) => {
      if (key) update(key, withDismissed(snapshot(key), dismissed));
    },
    [key],
  );
  const restore = useCallback(
    (restored: readonly string[]) => {
      if (key) update(key, withoutDismissed(snapshot(key), restored));
    },
    [key],
  );
  return useMemo(() => ({ ids, dismiss, restore }), [ids, dismiss, restore]);
}
