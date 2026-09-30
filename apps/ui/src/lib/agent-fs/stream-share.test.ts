import { afterEach, describe, expect, test } from "bun:test";
import { AgentFsClient } from "./client";
import type { DriveEvent, DriveStreamState } from "./stream";
import {
  type LockRequester,
  openSharedDriveStream,
  type RelayChannel,
  type StreamShare,
} from "./stream-share";

const encoder = new TextEncoder();
const realFetch = globalThis.fetch;
const NAME = "comb-live http://fs.test user-1 org-1/drive-1";

const READY = 'event: ready\ndata: {"driveId":"drive-1","at":"2026-09-30T10:00:00.000Z"}\n\n';
const FILE_CHANGED = `event: file.changed\ndata: ${JSON.stringify({
  driveId: "drive-1",
  path: "docs/a.md",
  version: 3,
  operation: "edit",
  actor: "user-2",
  at: "2026-09-30T10:00:01.000Z",
})}\n\n`;

/** Run every pending promise callback (`setImmediate` is a macrotask). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Each fetch opens a new controllable event stream, or answers `status`
 * when set. `streams` has one entry per fetch (null for an error answer).
 */
function mockStreams(status?: number) {
  const streams: Array<{ push(text: string): Promise<void> } | null> = [];
  globalThis.fetch = (async () => {
    if (status) {
      streams.push(null);
      return { ok: false, status, json: async () => ({ error: "ERR", message: "no" }) };
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let waiters: Array<() => void> = [];
    const body = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          controller = c;
        },
        // With no queue, `pull` runs once the reader has handled every chunk.
        pull: () => {
          const ready = waiters;
          waiters = [];
          for (const resolve of ready) resolve();
        },
      },
      { highWaterMark: 0 },
    );
    streams.push({
      push: (text) => {
        controller.enqueue(encoder.encode(text));
        return new Promise((resolve) => waiters.push(resolve));
      },
    });
    return { ok: true, status: 200, body };
  }) as unknown as typeof fetch;
  return streams;
}

/** `navigator.locks`: one holder per name, the waiters in request order, abortable while waiting. */
function fakeLocks(): LockRequester {
  const queues = new Map<string, Array<() => void>>();
  const held = new Set<string>();
  const grantNext = (name: string) => {
    const grant = queues.get(name)?.shift();
    if (!grant) return;
    held.add(name);
    queueMicrotask(grant);
  };
  return {
    request(name, { signal }, callback) {
      return new Promise((resolve, reject) => {
        const abortError = () => new DOMException("The lock request was aborted", "AbortError");
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const grant = () => {
          signal?.removeEventListener("abort", onAbort);
          callback()
            .then(resolve, reject)
            .finally(() => {
              held.delete(name);
              grantNext(name);
            });
        };
        const onAbort = () => {
          const queue = queues.get(name) ?? [];
          if (queue.includes(grant)) queue.splice(queue.indexOf(grant), 1);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queues.set(name, [...(queues.get(name) ?? []), grant]);
        if (!held.has(name)) grantNext(name);
      });
    },
  };
}

/** `BroadcastChannel`: delivers a copy to every other open channel of the same name, later. */
function fakeChannels(): (name: string) => RelayChannel {
  const open = new Set<{ name: string; listeners: Set<(event: MessageEvent) => void> }>();
  return (name) => {
    const self = { name, listeners: new Set<(event: MessageEvent) => void>() };
    open.add(self);
    return {
      postMessage(message) {
        for (const other of open) {
          if (other === self || other.name !== name) continue;
          const data = structuredClone(message);
          queueMicrotask(() => {
            if (!open.has(other)) return;
            for (const listener of other.listeners) listener({ data } as MessageEvent);
          });
        }
      },
      addEventListener: (_type, listener) => self.listeners.add(listener),
      removeEventListener: (_type, listener) => self.listeners.delete(listener),
      close: () => open.delete(self),
    };
  };
}

function browser(): StreamShare {
  return { name: NAME, locks: fakeLocks(), openChannel: fakeChannels() };
}

const tabs: Array<{ close(): void; done: Promise<void> }> = [];

function openTab(share: StreamShare | null) {
  const controller = new AbortController();
  const states: Array<[DriveStreamState, boolean]> = [];
  const events: DriveEvent[] = [];
  const done = openSharedDriveStream({
    client: new AgentFsClient({ endpoint: "http://fs.test", apiKey: "af_key" }),
    orgId: "org-1",
    driveId: "drive-1",
    share,
    onEvent: (event) => events.push(event),
    onState: (state, relayed) => states.push([state, relayed]),
    signal: controller.signal,
  });
  const tab = { states, events, done, close: () => controller.abort() };
  tabs.push(tab);
  return tab;
}

afterEach(async () => {
  for (const tab of tabs.splice(0)) tab.close();
  await flush();
  globalThis.fetch = realFetch;
});

describe("openSharedDriveStream", () => {
  test("one tab opens the stream, and the other follows its states and events", async () => {
    const streams = mockStreams();
    const share = browser();
    const leader = openTab(share);
    const follower = openTab(share);
    await flush();
    expect(streams).toHaveLength(1);

    await streams[0]?.push(READY + FILE_CHANGED);
    await flush();
    expect(leader.states).toEqual([
      ["connecting", false],
      ["live", false],
    ]);
    expect(follower.states).toEqual([
      ["connecting", true],
      ["live", true],
    ]);
    expect(leader.events.map((event) => event.type)).toEqual(["ready", "file.changed"]);
    // The follower resyncs when the relayed state turns live, then gets the events.
    expect(follower.events.map((event) => event.type)).toEqual(["ready", "file.changed"]);
    expect(follower.events[1]).toEqual(leader.events[1] as DriveEvent);
  });

  test("a tab that opens later gets the leader's state and resyncs", async () => {
    const streams = mockStreams();
    const share = browser();
    openTab(share);
    await flush();
    await streams[0]?.push(READY);

    const late = openTab(share);
    await flush();
    expect(streams).toHaveLength(1);
    expect(late.states).toEqual([["live", true]]);
    expect(late.events.map((event) => event.type)).toEqual(["ready"]);
  });

  test("the next tab opens its own stream when the leader closes", async () => {
    const streams = mockStreams();
    const share = browser();
    const leader = openTab(share);
    const follower = openTab(share);
    await flush();
    await streams[0]?.push(READY);
    await flush();

    leader.close();
    await leader.done;
    await flush();
    expect(streams).toHaveLength(2);
    await streams[1]?.push(READY);
    expect(follower.states).toEqual([
      ["connecting", true],
      ["live", true],
      ["connecting", false],
      ["live", false],
    ]);
    // Its own `ready` resyncs the gap between the two leaders.
    expect(follower.events.map((event) => event.type)).toEqual(["ready", "ready"]);
  });

  test("a refused stream keeps the lock: the followers poll and do not try again", async () => {
    const streams = mockStreams(401);
    const share = browser();
    const leader = openTab(share);
    const follower = openTab(share);
    await flush();
    await flush();
    expect(leader.states).toEqual([
      ["connecting", false],
      ["stopped", false],
    ]);
    expect(follower.states).toEqual([
      ["connecting", true],
      ["stopped", true],
    ]);
    expect(follower.events).toEqual([]);
    expect(streams).toEqual([null]);
  });

  test("without a share, every tab opens its own stream", async () => {
    const streams = mockStreams();
    const first = openTab(null);
    const second = openTab(null);
    await flush();
    expect(streams).toHaveLength(2);
    await streams[1]?.push(READY);
    expect(first.states).toEqual([["connecting", false]]);
    expect(second.states).toEqual([
      ["connecting", false],
      ["live", false],
    ]);
  });

  test("a tab that the browser refuses the lock streams alone", async () => {
    const streams = mockStreams();
    const refusing: StreamShare = {
      ...browser(),
      locks: { request: () => Promise.reject(new DOMException("denied", "SecurityError")) },
    };
    const tab = openTab(refusing);
    await flush();
    expect(streams).toHaveLength(1);
    await streams[0]?.push(READY);
    expect(tab.states).toEqual([
      ["connecting", false],
      ["live", false],
    ]);
  });
});
