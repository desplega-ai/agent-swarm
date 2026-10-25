import { useEffect, useSyncExternalStore } from "react";
import { useConfig } from "@/hooks/use-config";
import { browserStorage } from "@/lib/comb/drafts";
import type { DrivePath } from "@/lib/comb/paths";
import {
  type Drive,
  forgetViewed,
  readViewed,
  rememberViewed,
  type ViewedFile,
  viewedStorageKey,
  writeViewed,
} from "@/lib/comb/recent";

// This browser's Recently viewed lists (`lib/comb/recent.ts`), one per swarm
// and drive. One snapshot per storage key, so `useSyncExternalStore` gets the
// same array until the list changes. Another tab's change arrives as a
// `storage` event.

const NONE: ViewedFile[] = [];
const snapshots = new Map<string, ViewedFile[]>();
const listeners = new Set<() => void>();

function snapshot(key: string): ViewedFile[] {
  let list = snapshots.get(key);
  if (!list) {
    list = readViewed(browserStorage(), key);
    snapshots.set(key, list);
  }
  return list;
}

function update(key: string, list: ViewedFile[]) {
  snapshots.set(key, list);
  writeViewed(browserStorage(), key, list);
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

/** The files this browser opened on `drive`, newest first. */
export function useViewedFiles(drive: Drive): ViewedFile[] {
  const { apiUrl } = useConfig().config;
  const key = viewedStorageKey(apiUrl, drive);
  return useSyncExternalStore(
    subscribe,
    () => snapshot(key),
    () => NONE,
  );
}

/** Puts `file` on top of Recently viewed when it opens. Null: nothing to remember yet. */
export function useRememberViewed(file: DrivePath | null) {
  const { apiUrl } = useConfig().config;
  const key = file ? viewedStorageKey(apiUrl, file) : null;
  const path = file?.path ?? null;
  useEffect(() => {
    if (key && path) update(key, rememberViewed(snapshot(key), path, Date.now()));
  }, [key, path]);
}

/** Drops `file` from Recently viewed: it is gone (a 404). Null: nothing to drop. */
export function useForgetViewed(file: DrivePath | null) {
  const { apiUrl } = useConfig().config;
  const key = file ? viewedStorageKey(apiUrl, file) : null;
  const path = file?.path ?? null;
  useEffect(() => {
    if (!key || !path) return;
    const list = snapshot(key);
    if (list.some((entry) => entry.path === path)) update(key, forgetViewed(list, path));
  }, [key, path]);
}
