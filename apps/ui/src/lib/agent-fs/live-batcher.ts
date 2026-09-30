// The react-query side of Comb live updates. `useAgentFsLive` feeds each
// change-stream event's `keysToInvalidate` to a `LiveBatcher`, and closes the
// stream while `watchHidden` reports a hidden tab.

import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Events that arrive within this window refresh their queries together. */
export const LIVE_BATCH_MS = 50;

/** The timer functions the batcher and the watcher use. Tests pass a fake clock. */
export interface LiveTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: LiveTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LiveBatcher {
  /** Mark these key prefixes stale. They refresh `windowMs` after the first key of a batch. */
  add(keys: readonly QueryKey[]): void;
  /** Drop the pending batch and stop following fetches. */
  dispose(): void;
}

/** True when every part of `prefix` equals the same part of `key` (agent-fs keys hold only primitives). */
function isPrefix(prefix: QueryKey, key: QueryKey): boolean {
  return prefix.length <= key.length && prefix.every((part, index) => part === key[index]);
}

/**
 * Batch invalidations, and apply them so that no event is lost and a burst
 * does not starve the refresh.
 *
 * The rule: a fetch that is in flight when a batch flushes can have started
 * before the event, so its result is stale. The batcher does not cancel it
 * (`invalidateQueries` cancels by default, and an event every 60 ms would
 * then cancel every refetch until the burst ends). It lets the fetch land,
 * then invalidates that query again. The same rule covers a query with no
 * data yet: react-query joins its first fetch instead of a new one, and that
 * fetch clears `isInvalidated` when it lands. At most one extra fetch per
 * query, when the fetch started after the event.
 *
 * Coalescing: a key that a pending key already covers (same key or a longer
 * one under a pending prefix, such as a file's `stat` under the `ready`
 * resync's `stat` prefix) is dropped, and a new prefix replaces the pending
 * keys it covers.
 */
export function createLiveBatcher({
  queryClient,
  windowMs = LIVE_BATCH_MS,
  timers = browserTimers,
}: {
  queryClient: QueryClient;
  windowMs?: number;
  timers?: LiveTimers;
}): LiveBatcher {
  const cache = queryClient.getQueryCache();
  let pending: QueryKey[] = [];
  let timer: unknown = null;
  // Queries whose in-flight fetch is stale, by query hash: refresh each when it settles.
  const afterFetch = new Map<string, QueryKey>();

  const unsubscribe = cache.subscribe((event) => {
    const { query } = event;
    if (!afterFetch.has(query.queryHash)) return;
    if (event.type !== "removed" && query.state.fetchStatus === "fetching") return;
    afterFetch.delete(query.queryHash);
    if (event.type === "removed") return;
    // Run after the dispatch that settled the fetch, not inside it. A fetch
    // that started since then began after the event: join it.
    queueMicrotask(() => {
      void queryClient.invalidateQueries(
        { queryKey: query.queryKey, exact: true },
        { cancelRefetch: false },
      );
    });
  });

  function flush() {
    timer = null;
    const keys = pending;
    pending = [];
    for (const queryKey of keys) {
      for (const query of cache.findAll({ queryKey, fetchStatus: "fetching" })) {
        afterFetch.set(query.queryHash, query.queryKey);
      }
      void queryClient.invalidateQueries({
        queryKey,
        predicate: (query) => query.state.fetchStatus !== "fetching",
      });
    }
  }

  return {
    add(keys) {
      for (const key of keys) {
        if (pending.some((prefix) => isPrefix(prefix, key))) continue;
        pending = pending.filter((other) => !isPrefix(key, other));
        pending.push(key);
      }
      if (timer === null && pending.length > 0) timer = timers.setTimeout(flush, windowMs);
    },
    dispose() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      pending = [];
      afterFetch.clear();
      unsubscribe();
    },
  };
}

/** The `document` parts `watchHidden` reads. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Call `onChange(true)` once the page has stayed hidden for `ms`, and
 * `onChange(false)` when it is visible again after that. A shorter hide
 * calls nothing. Returns the stop function.
 */
export function watchHidden({
  doc,
  ms,
  onChange,
  timers = browserTimers,
}: {
  doc: VisibilitySource;
  ms: number;
  onChange: (hidden: boolean) => void;
  timers?: LiveTimers;
}): () => void {
  let timer: unknown = null;
  let paused = false;
  const update = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (doc.visibilityState === "hidden") {
      if (paused) return;
      timer = timers.setTimeout(() => {
        timer = null;
        paused = true;
        onChange(true);
      }, ms);
    } else if (paused) {
      paused = false;
      onChange(false);
    }
  };
  update();
  doc.addEventListener("visibilitychange", update);
  return () => {
    if (timer !== null) timers.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", update);
  };
}
