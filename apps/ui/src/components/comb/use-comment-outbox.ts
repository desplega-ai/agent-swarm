import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { CommentAddParams } from "@/lib/agent-fs/types";
import {
  addToOutbox,
  type CommentScope,
  type DraftStorage,
  discardFromOutbox,
  type OutboxEntry,
  outboxStorageKey,
  readOutbox,
  retryOutbox,
  writeOutbox,
} from "@/lib/comb/drafts";

export interface CommentOutbox {
  entries: OutboxEntry[];
  add: (params: CommentAddParams, error: string) => void;
  discard: (id: string) => void;
  /** Send every entry again. Sent ones leave the outbox. */
  retryAll: () => Promise<void>;
  retrying: boolean;
}

function browserStorage(): DraftStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Same-tab writers notify here. Other tabs arrive through the `storage` event.
const listeners = new Set<() => void>();
const retryingKeys = new Set<string>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * The comments of one file that failed to post (network error or 5xx), kept
 * in localStorage so they survive a reload. `send` posts one `comment-add`.
 */
export function useCommentOutbox(
  scope: CommentScope,
  send: (params: CommentAddParams) => Promise<unknown>,
): CommentOutbox {
  const key = outboxStorageKey(scope);
  const raw = useSyncExternalStore(subscribe, () => browserStorage()?.getItem(key) ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `raw` is the change signal for the stored list.
  const entries = useMemo(() => readOutbox(browserStorage(), key), [key, raw]);
  const sendRef = useRef(send);
  sendRef.current = send;

  const update = useCallback(
    (change: (current: OutboxEntry[]) => OutboxEntry[]) => {
      const storage = browserStorage();
      writeOutbox(storage, key, change(readOutbox(storage, key)));
      notify();
    },
    [key],
  );

  const add = useCallback(
    (params: CommentAddParams, error: string) =>
      update((current) =>
        addToOutbox(current, { id: crypto.randomUUID(), params, error, now: new Date() }),
      ),
    [update],
  );

  const discard = useCallback(
    (id: string) => update((current) => discardFromOutbox(current, id)),
    [update],
  );

  const retryAll = useCallback(async () => {
    // One retry at a time per file (the Retry button and the `online` event can race).
    if (retryingKeys.has(key)) return;
    const attempted = readOutbox(browserStorage(), key);
    if (attempted.length === 0) return;
    retryingKeys.add(key);
    notify();
    try {
      const left = await retryOutbox(attempted, (params) => sendRef.current(params));
      const tried = new Set(attempted.map((entry) => entry.id));
      const failed = new Map(left.map((entry) => [entry.id, entry]));
      // Entries added while the retry ran stay as they are.
      update((current) =>
        current
          .filter((entry) => !tried.has(entry.id) || failed.has(entry.id))
          .map((entry) => failed.get(entry.id) ?? entry),
      );
    } finally {
      retryingKeys.delete(key);
      notify();
    }
  }, [key, update]);

  const retrying = useSyncExternalStore(subscribe, () => retryingKeys.has(key));

  return { entries, add, discard, retryAll, retrying };
}
