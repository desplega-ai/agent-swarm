import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient, type QueryKey, QueryObserver } from "@tanstack/react-query";
import { createLiveBatcher, type LiveTimers, watchHidden } from "./live-batcher";

const PREFIX = ["agent-fs", "http://fs.test", "user-1", "org-1", "drive-1"];
const STAT_A: QueryKey = [...PREFIX, "stat", "/a.md"];

/** Run every pending promise callback (`setImmediate` is a macrotask). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A manual clock for the batcher, the watcher, and the fake fetches. */
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    get now() {
      return now;
    },
    setTimeout(callback: () => void, ms: number) {
      nextId++;
      timers.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    sleep(ms: number) {
      return new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
    },
    /** Run the timers due within `ms` in time order, and let each one's promise chains settle. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
      await flush();
    },
  } satisfies LiveTimers & Record<string, unknown>;
  return clock;
}

/**
 * One mounted `stat` query whose fetch takes 100 ms and returns the server
 * version at the moment the request starts.
 */
function mountQuery() {
  const clock = fakeClock();
  const queryClient = new QueryClient();
  const server = { version: 0 };
  const fetchStarts: number[] = [];
  const observer = new QueryObserver(queryClient, {
    queryKey: STAT_A,
    queryFn: async () => {
      const version = server.version;
      fetchStarts.push(clock.now);
      await clock.sleep(100);
      return version;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const batcher = createLiveBatcher({ queryClient, timers: clock });
  cleanups.push(() => {
    batcher.dispose();
    unsubscribe();
    queryClient.clear();
  });
  return {
    clock,
    queryClient,
    server,
    fetchStarts,
    batcher,
    data: () => queryClient.getQueryData<number>(STAT_A),
  };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

describe("createLiveBatcher", () => {
  test("refreshes once per batch, 50 ms after its first key", async () => {
    const q = mountQuery();
    await q.clock.advance(100);
    expect(q.fetchStarts).toEqual([0]);

    q.batcher.add([STAT_A]);
    await q.clock.advance(30);
    q.batcher.add([STAT_A]);
    await q.clock.advance(19);
    expect(q.fetchStarts).toEqual([0]);
    await q.clock.advance(1);
    expect(q.fetchStarts).toEqual([0, 150]);
  });

  test("drops a key that a pending key covers, and a prefix replaces the keys under it", async () => {
    const clock = fakeClock();
    const queryClient = new QueryClient();
    const invalidate = spyOn(queryClient, "invalidateQueries");
    const batcher = createLiveBatcher({ queryClient, timers: clock });
    cleanups.push(() => batcher.dispose());

    batcher.add([STAT_A, [...PREFIX, "ls", "/"]]);
    batcher.add([STAT_A]);
    // The `ready` resync's prefix covers every stat query of the drive.
    batcher.add([[...PREFIX, "stat"]]);
    batcher.add([[...PREFIX, "stat", "/b.md"]]);
    await clock.advance(50);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      [...PREFIX, "ls", "/"],
      [...PREFIX, "stat"],
    ]);
  });

  test("a burst of events does not starve the refresh: the data moves during the burst", async () => {
    const q = mountQuery();
    await q.clock.advance(100);
    expect(q.data()).toBe(0);

    // 20 events, 60 ms apart. Each fetch takes 100 ms.
    const seen: Array<number | undefined> = [];
    for (let version = 1; version <= 20; version++) {
      q.server.version = version;
      q.batcher.add([STAT_A]);
      await q.clock.advance(60);
      seen.push(q.data());
    }
    const steps = seen.filter((value, index) => index > 0 && value !== seen[index - 1]).length;
    expect(steps).toBeGreaterThanOrEqual(8);
    // At the last event the view is at most a few events behind.
    expect(seen.at(-1)).toBeGreaterThanOrEqual(17);

    await q.clock.advance(1000);
    expect(q.data()).toBe(20);
  });

  test("an event during the first fetch (no data yet) is not lost", async () => {
    const q = mountQuery();
    await q.clock.advance(10);
    expect(q.data()).toBeUndefined();

    // The first `ready` arrives while the first fetch reads version 0.
    q.server.version = 1;
    q.batcher.add([[...PREFIX, "stat"]]);
    await q.clock.advance(90);
    expect(q.data()).toBe(0);
    await q.clock.advance(100);
    expect(q.data()).toBe(1);
    expect(q.fetchStarts).toEqual([0, 100]);
  });

  test("an event during a refetch refreshes again after that fetch lands", async () => {
    const q = mountQuery();
    await q.clock.advance(100);
    void q.queryClient.refetchQueries({ queryKey: STAT_A });
    await q.clock.advance(10);

    q.server.version = 1;
    q.batcher.add([STAT_A]);
    await q.clock.advance(90);
    // The refetch that started before the event landed version 0.
    expect(q.data()).toBe(0);
    await q.clock.advance(100);
    expect(q.data()).toBe(1);
    expect(q.fetchStarts).toEqual([0, 100, 200]);
  });

  test("dispose drops the pending batch and the follow-up fetches", async () => {
    const q = mountQuery();
    await q.clock.advance(100);
    void q.queryClient.refetchQueries({ queryKey: STAT_A });
    q.batcher.add([STAT_A]);
    await q.clock.advance(50);
    q.batcher.add([STAT_A]);
    q.batcher.dispose();
    await q.clock.advance(500);
    expect(q.fetchStarts).toEqual([0, 100]);
  });
});

/** A `document` with a settable visibility. */
function fakeDocument(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  return {
    visibilityState: initial,
    listeners,
    addEventListener: (_type: "visibilitychange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      listeners.delete(listener),
    set(state: DocumentVisibilityState) {
      this.visibilityState = state;
      for (const listener of listeners) listener();
    },
  };
}

describe("watchHidden (visibility pause)", () => {
  function watch(initial: DocumentVisibilityState) {
    const clock = fakeClock();
    const doc = fakeDocument(initial);
    const changes: boolean[] = [];
    const stop = watchHidden({
      doc,
      ms: 10_000,
      onChange: (hidden) => changes.push(hidden),
      timers: clock,
    });
    return { clock, doc, changes, stop };
  }

  test("pauses after 10 s hidden and resumes as soon as the tab is visible", async () => {
    const w = watch("visible");
    w.doc.set("hidden");
    await w.clock.advance(9_999);
    expect(w.changes).toEqual([]);
    await w.clock.advance(1);
    expect(w.changes).toEqual([true]);
    await w.clock.advance(60_000);
    expect(w.changes).toEqual([true]);
    w.doc.set("visible");
    expect(w.changes).toEqual([true, false]);
  });

  test("a shorter hide does nothing", async () => {
    const w = watch("visible");
    w.doc.set("hidden");
    await w.clock.advance(5_000);
    w.doc.set("visible");
    await w.clock.advance(60_000);
    expect(w.changes).toEqual([]);
  });

  test("a tab that starts hidden pauses after 10 s", async () => {
    const w = watch("hidden");
    await w.clock.advance(10_000);
    expect(w.changes).toEqual([true]);
  });

  test("stop removes the listener and the timer", async () => {
    const w = watch("visible");
    w.doc.set("hidden");
    w.stop();
    await w.clock.advance(60_000);
    expect(w.changes).toEqual([]);
    expect(w.doc.listeners.size).toBe(0);
  });
});
