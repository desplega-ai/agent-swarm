import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { AgentFsClient } from "./client";
import {
  backoffDelay,
  type DriveEvent,
  type DriveStreamState,
  openDriveStream,
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
  push(text: string): void;
  close(): void;
  canceled: boolean;
}

function streamResponse(): { response: Response; stream: FakeStream } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream: FakeStream = {
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    canceled: false,
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      stream.canceled = true;
    },
  });
  return { response: { ok: true, status: 200, body } as unknown as Response, stream };
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "ERR", message: `agent-fs said ${status}` }),
  } as unknown as Response;
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Answer fetch calls in order with `responders`; the last one repeats. */
function mockFetch(...responders: Array<() => Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const respond = responders[Math.min(calls.length, responders.length) - 1];
    return (respond as () => Response)();
  }) as typeof fetch;
  return calls;
}

const networkDown = (): Response => {
  throw new TypeError("fetch failed");
};

/** Let pending promise chains (fetch, stream reads) run. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await settle();
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

beforeEach(() => {
  jest.useFakeTimers();
  // The top of each jitter range, so delays are exact.
  spyOn(Math, "random").mockReturnValue(1);
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
    expect(backoffDelay(Number.POSITIVE_INFINITY, 0.5)).toBe(22500);
  });
});

describe("openDriveStream", () => {
  test("opens the drive's events with the Bearer key, goes live on ready, and forwards events", async () => {
    const first = streamResponse();
    const calls = mockFetch(() => first.response);
    const run = start();
    await settle();
    first.stream.push(READY + PING + FILE_CHANGED);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://fs.test/orgs/org-1/drives/drive-1/events");
    const headers = calls[0]?.init.headers as Record<string, string>;
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
    mockFetch(() => first.response);
    const run = start();
    await settle();
    first.stream.push(
      `${READY}event: share.changed\ndata: {}\n\nevent: file.changed\ndata: not json\n\nevent: file.changed\ndata: {"version":1}\n\n`,
    );
    await settle();
    expect(run.events.map((event) => event.type)).toEqual(["ready"]);
    run.abort();
    await run.done;
  });

  test("reconnects after 1 s, 2 s, 4 s ... capped at 30 s", async () => {
    const calls = mockFetch(networkDown);
    const run = start();
    await settle();
    expect(calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "retrying"]);

    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = calls.length;
      await advance(delay - 1);
      expect(calls).toHaveLength(before);
      await advance(1);
      expect(calls).toHaveLength(before + 1);
    }
    run.abort();
    await run.done;
  });

  test("a 401 stops without a retry", async () => {
    const calls = mockFetch(() => errorResponse(401));
    const run = start();
    await run.done;
    await advance(120_000);
    expect(calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "stopped"]);
  });

  test("a 404 on reconnect (removed member) stops", async () => {
    const first = streamResponse();
    const calls = mockFetch(
      () => first.response,
      () => errorResponse(404),
    );
    const run = start();
    await settle();
    first.stream.push(READY);
    await settle();
    first.stream.close();
    await settle();
    expect(run.states).toEqual(["connecting", "live", "retrying"]);

    await advance(1000);
    await run.done;
    expect(calls).toHaveLength(2);
    expect(run.states).toEqual(["connecting", "live", "retrying", "stopped"]);
  });

  test("a 429 waits the full 30 s cap", async () => {
    const second = streamResponse();
    const calls = mockFetch(
      () => errorResponse(429),
      () => second.response,
    );
    const run = start();
    await settle();
    await advance(29_999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
    second.stream.push(READY);
    await settle();
    expect(run.states).toEqual(["connecting", "retrying", "live"]);
    run.abort();
    await run.done;
  });

  test("pings keep a quiet stream open", async () => {
    const first = streamResponse();
    const calls = mockFetch(() => first.response);
    const run = start();
    await settle();
    first.stream.push(READY);
    await settle();
    for (let i = 0; i < 30; i++) {
      await advance(5000);
      first.stream.push(PING);
      await settle();
    }
    expect(calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "live"]);
    run.abort();
    await run.done;
  });

  test("60 s without a byte closes the stream and reconnects", async () => {
    const first = streamResponse();
    const second = streamResponse();
    const calls = mockFetch(
      () => first.response,
      () => second.response,
    );
    const run = start();
    await settle();
    first.stream.push(READY);
    await settle();

    await advance(STREAM_DEAD_MS - 1);
    expect(run.states).toEqual(["connecting", "live"]);
    await advance(1);
    expect(first.stream.canceled).toBe(true);
    expect(run.states).toEqual(["connecting", "live", "retrying"]);
    await advance(1000);
    expect(calls).toHaveLength(2);
    second.stream.push(READY);
    await settle();
    expect(run.states).toEqual(["connecting", "live", "retrying", "live"]);
    expect(run.events.filter((event) => event.type === "ready")).toHaveLength(2);
    run.abort();
    await run.done;
  });

  test("60 s of healthy connection resets the backoff", async () => {
    const third = streamResponse();
    const calls = mockFetch(networkDown, networkDown, () => third.response);
    const run = start();
    await settle();
    await advance(1000);
    await advance(2000);
    expect(calls).toHaveLength(3);
    third.stream.push(READY);
    await settle();
    await advance(STREAM_HEALTHY_MS / 2);
    third.stream.push(PING);
    await settle();
    await advance(STREAM_HEALTHY_MS / 2);
    third.stream.close();
    await settle();

    // The next delay is 1 s again, not 4 s.
    await advance(999);
    expect(calls).toHaveLength(3);
    await advance(1);
    expect(calls).toHaveLength(4);
    run.abort();
    await run.done;
  });

  test("abort closes the body and stops every timer", async () => {
    const first = streamResponse();
    const calls = mockFetch(() => first.response);
    const run = start();
    await settle();
    first.stream.push(READY);
    await settle();

    run.abort();
    await run.done;
    expect(first.stream.canceled).toBe(true);
    await advance(10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "live"]);
  });

  test("abort during a reconnect wait ends at once", async () => {
    const calls = mockFetch(networkDown);
    const run = start();
    await settle();
    expect(run.states).toEqual(["connecting", "retrying"]);
    run.abort();
    await run.done;
    await advance(60_000);
    expect(calls).toHaveLength(1);
    expect(run.states).toEqual(["connecting", "retrying"]);
  });
});
