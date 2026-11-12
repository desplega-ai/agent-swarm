// Composer drafts: the text in one agent composer (`ComposerDock`), kept in
// this browser's localStorage so a reload, a crash or a closed tab does not
// lose it. Comb's comment drafts (`lib/comb/drafts.ts`) own the storage
// format; this adds the per-key store the composers read with
// `useSyncExternalStore`, so only the composer re-renders on a keystroke.
//
// - Keyed by surface: `composer:<surface>:<rootTaskId | taskId | "new">`,
//   namespaced by the swarm API URL.
// - Saved 300 ms after the last keystroke, and flushed when the page hides.
// - Expires after 7 days (comb's `DRAFT_MAX_AGE_MS`).
// - Two tabs: last write wins, and the `storage` event updates the other tab.
// - Text only. Attachments stay in memory.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useCallback, useState, useSyncExternalStore } from "react";
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import {
  browserStorage,
  clearDraft,
  type DraftStorage,
  readDraft,
  writeDraft,
} from "./comb/drafts";
import { getConfig } from "./config";

export const DRAFT_SAVE_DELAY_MS = 300;

type Listener = () => void;

/** A drafts store over one storage. The app uses `composerDrafts`. */
export function createDraftStore(
  storage: DraftStorage | null,
  opts: { now?: () => number; saveDelayMs?: number } = {},
) {
  const now = opts.now ?? Date.now;
  const saveDelayMs = opts.saveDelayMs ?? DRAFT_SAVE_DELAY_MS;
  const texts = new Map<string, string>();
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const notify = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };

  const save = (key: string) => {
    pending.delete(key);
    writeDraft(storage, key, texts.get(key) ?? "", now());
  };

  return {
    get(key: string): string {
      let text = texts.get(key);
      if (text === undefined) {
        text = readDraft(storage, key, now());
        texts.set(key, text);
      }
      return text;
    },
    set(key: string, text: string): void {
      if (texts.get(key) === text) return;
      texts.set(key, text);
      notify(key);
      clearTimeout(pending.get(key));
      // An emptied box (a sent message) is removed at once, not after the delay.
      if (text.trim() === "") save(key);
      else
        pending.set(
          key,
          setTimeout(() => save(key), saveDelayMs),
        );
    },
    /** After a successful send: drop the text now, with no pending save left to restore it. */
    clear(key: string): void {
      clearTimeout(pending.get(key));
      pending.delete(key);
      clearDraft(storage, key);
      if (texts.get(key) === "") return;
      texts.set(key, "");
      notify(key);
    },
    /** Writes every pending save now (the page is hiding). */
    flush(): void {
      for (const [key, timer] of pending) {
        clearTimeout(timer);
        save(key);
      }
    },
    /** Another tab wrote `key` (its full storage key). Ignored unless this tab reads it. */
    external(key: string): void {
      if (!texts.has(key) || pending.has(key)) return;
      const text = readDraft(storage, key, now());
      if (texts.get(key) === text) return;
      texts.set(key, text);
      notify(key);
    },
    subscribe(key: string, listener: Listener): () => void {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

export const composerDrafts = createDraftStore(browserStorage());

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => composerDrafts.flush());
  window.addEventListener("storage", (event) => {
    if (event.key) composerDrafts.external(event.key);
  });
}

/** The storage key for a composer key, scoped to the connected swarm. */
export function composerDraftStorageKey(key: string): string {
  return deriveStorageKey(getConfig().apiUrl, `composer:draft:${key}`);
}

const noop = () => () => {};

/**
 * The draft text for `key` and its setter, plus `clear` for a successful
 * send. Without a key it is plain component state that nothing persists.
 */
export function useComposerDraft(
  key: string | undefined,
  store: DraftStore = composerDrafts,
): { text: string; setText: (text: string) => void; clear: () => void } {
  const storageKey = key ? composerDraftStorageKey(key) : undefined;
  const [local, setLocal] = useState("");
  const subscribe = useCallback(
    (listener: Listener) => (storageKey ? store.subscribe(storageKey, listener) : noop()),
    [store, storageKey],
  );
  const stored = useSyncExternalStore(subscribe, () => (storageKey ? store.get(storageKey) : ""));
  const setText = useCallback(
    (next: string) => (storageKey ? store.set(storageKey, next) : setLocal(next)),
    [store, storageKey],
  );
  const clear = useCallback(
    () => (storageKey ? store.clear(storageKey) : setLocal("")),
    [store, storageKey],
  );
  return { text: storageKey ? stored : local, setText, clear };
}
