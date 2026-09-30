import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { CommentAddParams, CommentListEntry } from "@/lib/agent-fs/types";
import {
  addToOutbox,
  browserStorage,
  type CommentScope,
  discardFromOutbox,
  type OutboxEntry,
  type OutboxLocks,
  outboxStorageKey,
  parseOutbox,
  readOutbox,
  retryOutboxEntries,
  returnToOutbox,
  writeOutbox,
} from "@/lib/comb/drafts";

export interface CommentOutbox {
  /** The connected user's unsent comments, oldest first, the ones being sent included. */
  entries: OutboxEntry[];
  /** Ids this tab is sending right now. */
  sending: ReadonlySet<string>;
  add: (params: CommentAddParams, error: string) => void;
  /** Drop an entry. Does nothing while the entry is being sent. */
  discard: (id: string) => void;
  retry: (id: string) => Promise<void>;
  retryAll: () => Promise<void>;
}

const NONE: OutboxEntry[] = [];

// Same-tab writers notify here. Other tabs arrive through the `storage` event.
const listeners = new Set<() => void>();
// The entries this tab took out of storage to send, per outbox key, and an
// immutable copy per key for `useSyncExternalStore`.
const inFlightByKey = new Map<string, Map<string, OutboxEntry>>();
const inFlightSnapshots = new Map<string, OutboxEntry[]>();

function notify() {
  for (const [key, entries] of inFlightByKey) inFlightSnapshots.set(key, [...entries.values()]);
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

function inFlightFor(key: string): Map<string, OutboxEntry> {
  let entries = inFlightByKey.get(key);
  if (!entries) {
    entries = new Map();
    inFlightByKey.set(key, entries);
  }
  return entries;
}

// A page that closes mid-send puts its claimed entries back, so a comment is
// never lost. If the send landed after all, the next retry finds the comment
// (`alreadyPosted`) and drops the entry.
let pagehideBound = false;
function bindPagehide() {
  if (pagehideBound || typeof window === "undefined") return;
  pagehideBound = true;
  window.addEventListener("pagehide", () => {
    for (const [key, entries] of inFlightByKey) {
      returnToOutbox(browserStorage(), key, [...entries.values()]);
      entries.clear();
    }
    notify();
  });
}

function webLocks(): OutboxLocks | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
}

/**
 * The comments of one file that failed to post (network error or 5xx), kept
 * in localStorage so they survive a reload. Only the connected user's entries
 * show and send. `send` posts one `comment-add`. `fetchThreads` reads the
 * file's threads fresh, so a retry skips a comment that already landed.
 */
export function useCommentOutbox(
  scope: CommentScope,
  io: {
    send: (params: CommentAddParams) => Promise<unknown>;
    fetchThreads: () => Promise<CommentListEntry[]>;
  },
): CommentOutbox {
  bindPagehide();
  const key = outboxStorageKey(scope);
  const { userId } = scope;
  const stored = useSyncExternalStore(subscribe, () => browserStorage()?.getItem(key) ?? null);
  const inFlight = useSyncExternalStore(subscribe, () => inFlightSnapshots.get(key) ?? NONE);
  const ioRef = useRef(io);
  ioRef.current = io;

  const sending = useMemo(() => new Set(inFlight.map((entry) => entry.id)), [inFlight]);
  const entries = useMemo(() => {
    const waiting = parseOutbox(stored).filter(
      (entry) => entry.userId === userId && !sending.has(entry.id),
    );
    return [...waiting, ...inFlight].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [stored, inFlight, sending, userId]);

  const add = useCallback(
    (params: CommentAddParams, error: string) => {
      const storage = browserStorage();
      const entry = { id: crypto.randomUUID(), userId, params, error, now: new Date() };
      writeOutbox(storage, key, addToOutbox(readOutbox(storage, key), entry));
      notify();
    },
    [key, userId],
  );

  const discard = useCallback(
    (id: string) => {
      if (inFlightFor(key).has(id)) return;
      const storage = browserStorage();
      writeOutbox(storage, key, discardFromOutbox(readOutbox(storage, key), id));
      notify();
    },
    [key],
  );

  const run = useCallback(
    (ids?: ReadonlySet<string>) =>
      retryOutboxEntries({
        storage: browserStorage(),
        key,
        userId,
        ids,
        send: (params) => ioRef.current.send(params),
        fetchThreads: () => ioRef.current.fetchThreads(),
        inFlight: inFlightFor(key),
        onChange: notify,
        locks: webLocks(),
      }),
    [key, userId],
  );
  const retry = useCallback((id: string) => run(new Set([id])), [run]);
  const retryAll = useCallback(() => run(), [run]);

  return useMemo(
    () => ({ entries, sending, add, discard, retry, retryAll }),
    [entries, sending, add, discard, retry, retryAll],
  );
}
