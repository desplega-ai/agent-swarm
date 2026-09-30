import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { AgentFsClient } from "./client";
import { SSE_MAX_PENDING } from "./sse";
import {
  backoffDelay,
  type DriveEvent,
  type DriveStreamState,
  openDriveStream,
  STREAM_BACKOFF_CAP_MS,
  STREAM_DEAD_MS,
  STREAM_HEALTHY_MS,
} from "./stream";

const KEY = "af_secret_0123456789abcdefghij";
const encoder = new TextEncoder();
const realFetch = globalThis.fetch;

const READY = 'event: ready\ndata: {"driveId":"drive-1","at":"2026-09-30T10:00:00.000Z"}\n\n';
const PING = ": ping\n\n";
const FILE_CHANGED = `event: file.changed\ndata: ${JSON.stringify({
  driveId: "drive-1",
  path: "docs/a.md",
  version: 3,
  operation: "edit",
  actor: "user-2",
  at: "2026-09-30T10:00:01.000Z",
})}\n\n`;

/** A controllable event-stream body. */
interface FakeStream {
  /** Send a chunk. Resolves once the reader has handled it and waits for the next one. */
  push(text: string): Promise<void>;
  close(): void;
  canceled: boolean;
}

function streamResponse(): { response: Response; stream: FakeStream } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let waiters: Array<() => void> = [];
  const stream: FakeStream = {
    push: (text) => {
      controller.enqueue(encoder.encode(text));
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => controller.close(),
    canceled: false,
  };
  // With no queue (high-water mark 0), `pull` runs only when a read waits
  // for data: the reader has handled every chunk before it.
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        const ready = waiters;
        waiters = [];
        for (const resolve of ready) resolve();
      },
      cancel() {
        stream.canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: { ok: true, status: 200, body } as unknown as Response, stream };
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "ERR", message: `agent-fs said ${status}` }),
  } as unknown as Response;
}

interface FetchMock {
  calls: Array<{ url: string; init: RequestInit }>;
  /** Resolves when fetch has been called `count` times. */
  called(count: number): Promise<void>;
}

/** Answer fetch calls in order with `responders`; the last one repeats. */
function mockFetch(...responders: Array<() => Response>): FetchMock {
  const calls: FetchMock["calls"] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    for (const waiter of waiters.filter((w) => w.count <= calls.length)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const respond = responders[Math.min(calls.length, responders.length) - 1];
    return (respond as () => Response)();
  }) as typeof fetch;
  return {
    calls,
    called: (count) =>
      count <= calls.length
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
  };
}

const networkDown = (): Response => {
  throw new TypeError("fetch failed");
};

/**
 * Run every pending promise callback. `setImmediate` is a macrotask, and
 * bun's fake timers leave it real, so the microtask queue is empty when it
 * fires, however long the chain.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Move the fake clock after the pending chains have set their timers. */
async function advance(ms: number) {
  await flush();
  jest.advanceTimersByTime(ms);
  await flush();
}

function start() {
  const controller = new AbortController();
  const states: DriveStreamState[] = [];
  const events: DriveEvent[] = [];
  const done = openDriveStream({
    client: new AgentFsClient({ endpoint: "http://fs.test/", apiKey: KEY }),
    orgId: "org-1",
    driveId: "drive-1",
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    signal: controller.signal,
  });
  return { states, events, done, abort: () => controller.abort() };
}

/** The top of each jitter range, so backoff delays are exact. */
function noJitter() {
  spyOn(Math, "random").mockReturnValue(1);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe("backoffDelay", () => {
  test("doubles from 1 s to a 30 s cap, jittered within the upper half", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((attempt) => backoffDelay(attempt, 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(5, 0)).toBe(15000);
  });
});

describe("openDriveStream", () => {
  test("opens the drive's events with the Bearer key, goes live on ready, and forwards events", async () => {
    const first = streamResponse();
    const fetchMock = mockFetch(() => first.response);
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(READY + PING + FILE_CHANGED);

    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0]?.url).toBe("http://fs.test/orgs/org-1/drives/drive-1/events");
    const headers = fetchMock.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers.Accept).toBe("text/event-stream");
    expect(run.states).toEqual(["connecting", "live"]);
    expect(run.events).toEqual([
      { type: "ready", driveId: "drive-1", at: "2026-09-30T10:00:00.000Z" },
      {
        type: "file.changed",
        driveId: "drive-1",
        path: "docs/a.md",
        version: 3,
        operation: "edit",
        actor: "user-2",
        at: "2026-09-30T10:00:01.000Z",
      },
    ]);
    run.abort();
    await run.done;
  });

  test("skips unknown events and bad payloads", async () => {
    const first = streamResponse();
    const fetchMock = mockFetch(() => first.response);
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(
      `${READY}event: share.changed\ndata: {}\n\nevent: file.changed\ndata: not json\n\nevent: file.changed\ndata: {"version":1}\n\n`,
    );
    expect(run.events.map((event) => event.type)).toEqual(["ready"]);
    run.abort();
    await run.done;
  });

  test("reconnects after 1 s, 2 s, 4 s ... capped at 30 s", async () => {
    noJitter();
    const fetchMock = mockFetch(networkDown);
    const run = start();
    await fetchMock.called(1);
    await flush();
    expect(run.states).toEqual(["connecting", "retrying"]);

    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = fetchMock.calls.length;
      await advance(delay - 1);
      expect(fetchMock.calls).toHaveLength(before);
      await advance(1);
      await fetchMock.called(before + 1);
    }
    run.abort();
    await run.done;
  });

  test("a 503 retries with the backoff", async () => {
    noJitter();
    const second = streamResponse();
    const fetchMock = mockFetch(
      () => errorResponse(503),
      () => second.response,
    );
    const run = start();
    await fetchMock.called(1);
    await flush();
    expect(run.states).toEqual(["connecting", "retrying"]);
    await advance(999);
    expect(fetchMock.calls).toHaveLength(1);
    await advance(1);
    await fetchMock.called(2);
    await second.stream.push(READY);
    expect(run.states).toEqual(["connecting", "retrying", "live"]);
    run.abort();
    await run.done;
  });

  test("a 401 stops without a retry", async () => {
    const fetchMock = mockFetch(() => errorResponse(401));
    const run = start();
    await run.done;
    await advance(120_000);
    expect(fetchMock.calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "stopped"]);
  });

  test("a 404 on reconnect (removed member) stops", async () => {
    const first = streamResponse();
    const fetchMock = mockFetch(
      () => first.response,
      () => errorResponse(404),
    );
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(READY);
    first.stream.close();
    await flush();
    expect(run.states).toEqual(["connecting", "live", "retrying"]);

    await advance(1000);
    await run.done;
    expect(fetchMock.calls).toHaveLength(2);
    expect(run.states).toEqual(["connecting", "live", "retrying", "stopped"]);
  });

  test("a 429 waits exactly the 30 s cap", async () => {
    // No Math.random mock: the 429 wait has no jitter.
    const second = streamResponse();
    const fetchMock = mockFetch(
      () => errorResponse(429),
      () => second.response,
    );
    const run = start();
    await fetchMock.called(1);
    await advance(STREAM_BACKOFF_CAP_MS - 1);
    expect(fetchMock.calls).toHaveLength(1);
    await advance(1);
    await fetchMock.called(2);
    await second.stream.push(READY);
    expect(run.states).toEqual(["connecting", "retrying", "live"]);
    run.abort();
    await run.done;
  });

  test("pings keep a quiet stream open", async () => {
    const first = streamResponse();
    const fetchMock = mockFetch(() => first.response);
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(READY);
    for (let i = 0; i < 30; i++) {
      await advance(5000);
      await first.stream.push(PING);
    }
    expect(fetchMock.calls).toHaveLength(1);
    expect(first.stream.canceled).toBe(false);
    expect(run.states).toEqual(["connecting", "live"]);
    run.abort();
    await run.done;
  });

  test("60 s without a byte closes the stream and reconnects", async () => {
    const first = streamResponse();
    const second = streamResponse();
    const fetchMock = mockFetch(
      () => first.response,
      () => second.response,
    );
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(READY);

    await advance(STREAM_DEAD_MS - 1);
    expect(run.states).toEqual(["connecting", "live"]);
    await advance(1);
    expect(first.stream.canceled).toBe(true);
    expect(run.states).toEqual(["connecting", "live", "retrying"]);
    await advance(1000);
    await fetchMock.called(2);
    await second.stream.push(READY);
    expect(run.states).toEqual(["connecting", "live", "retrying", "live"]);
    expect(run.events.filter((event) => event.type === "ready")).toHaveLength(2);
    run.abort();
    await run.done;
  });

  test("an event larger than the parser limit closes the connection and reconnects", async () => {
    const first = streamResponse();
    const second = streamResponse();
    const fetchMock = mockFetch(
      () => first.response,
      () => second.response,
    );
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(READY);
    // The reader stops on this chunk, so do not wait for its next read.
    void first.stream.push(`data: ${"x".repeat(SSE_MAX_PENDING)}`);
    await flush();
    expect(first.stream.canceled).toBe(true);
    expect(run.states).toEqual(["connecting", "live", "retrying"]);
    await advance(1000);
    await fetchMock.called(2);
    await second.stream.push(READY);
    expect(run.states).toEqual(["connecting", "live", "retrying", "live"]);
    run.abort();
    await run.done;
  });

  test("60 s of healthy connection resets the backoff", async () => {
    noJitter();
    const third = streamResponse();
    const fetchMock = mockFetch(networkDown, networkDown, () => third.response);
    const run = start();
    await fetchMock.called(1);
    await advance(1000);
    await advance(2000);
    await fetchMock.called(3);
    await third.stream.push(READY);
    await advance(STREAM_HEALTHY_MS / 2);
    await third.stream.push(PING);
    await advance(STREAM_HEALTHY_MS / 2);
    third.stream.close();

    // The next delay is 1 s again, not 4 s.
    await advance(999);
    expect(fetchMock.calls).toHaveLength(3);
    await advance(1);
    await fetchMock.called(4);
    run.abort();
    await run.done;
  });

  test("abort closes the body and stops every timer", async () => {
    const first = streamResponse();
    const fetchMock = mockFetch(() => first.response);
    const run = start();
    await fetchMock.called(1);
    await first.stream.push(READY);

    run.abort();
    await run.done;
    expect(first.stream.canceled).toBe(true);
    await advance(10 * 60_000);
    expect(fetchMock.calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "live"]);
  });

  test("abort during a reconnect wait ends at once", async () => {
    const fetchMock = mockFetch(networkDown);
    const run = start();
    await fetchMock.called(1);
    await flush();
    expect(run.states).toEqual(["connecting", "retrying"]);
    run.abort();
    await run.done;
    await advance(60_000);
    expect(fetchMock.calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "retrying"]);
  });
});
