// The agent-fs drive change stream (feature `change-stream`):
// `GET /orgs/<org>/drives/<drive>/events`, Server-Sent Events, Bearer key.
// `AgentFsClient.openEvents` opens it, so the key stays in the client.
//
// Events are live only (no replay): a reconnect sends `ready` again, and the
// reader must refetch what it shows. agent-fs sends `: ping` every 5 s and
// allows 8 streams per user.

import { type AgentFsClient, AgentFsError } from "./client";
import { createSseParser, type SseMessage } from "./sse";

/** The stream is open. Sent first, and again after every reconnect. */
export interface DriveReadyEvent {
  type: "ready";
  driveId: string;
  at: string;
}

/**
 * A file version was committed. A move sends two events: `write` at the new
 * path, `delete` at the old path. `path` may come without the leading "/".
 */
export interface FileChangedEvent {
  type: "file.changed";
  driveId: string;
  path: string;
  version: number;
  operation: "write" | "edit" | "append" | "delete" | "revert";
  actor: string;
  at: string;
}

/** A comment changed. `path` is stored as the writer sent it, with or without "/". */
export interface CommentChangedEvent {
  type: "comment.changed";
  driveId: string;
  path: string;
  commentId: string;
  parentId: string | null;
  action: "created" | "updated" | "resolved" | "reopened" | "deleted";
  actor: string;
  at: string;
}

export type DriveEvent = DriveReadyEvent | FileChangedEvent | CommentChangedEvent;

/**
 * - `connecting`: the first connection is opening.
 * - `live`: `ready` arrived, events flow.
 * - `retrying`: the connection dropped, a reconnect is scheduled or opening.
 * - `stopped`: agent-fs refused the stream (a 4xx other than 429: key or
 *   membership). No retry.
 */
export type DriveStreamState = "connecting" | "live" | "retrying" | "stopped";

export const STREAM_BACKOFF_BASE_MS = 1000;
export const STREAM_BACKOFF_CAP_MS = 30_000;
/** A connection that stays up this long resets the backoff. */
export const STREAM_HEALTHY_MS = 60_000;
/** No byte for this long (not even a ping): the connection is dead. */
export const STREAM_DEAD_MS = 60_000;

/**
 * Delay before reconnect number `attempt + 1`: 1 s, 2 s, 4 s ... capped at
 * 30 s, then a random point in the upper half of that step, so many tabs do
 * not reconnect at the same moment. `random` is in [0, 1).
 */
export function backoffDelay(attempt: number, random: number): number {
  const step = Math.min(STREAM_BACKOFF_BASE_MS * 2 ** attempt, STREAM_BACKOFF_CAP_MS);
  return step / 2 + (step / 2) * random;
}

export interface DriveStreamOptions {
  client: AgentFsClient;
  orgId: string;
  driveId: string;
  onEvent: (event: DriveEvent) => void;
  onState: (state: DriveStreamState) => void;
  /** Abort to close the stream. No `onState` or `onEvent` call follows. */
  signal: AbortSignal;
}

/**
 * Keep the drive's change stream open until `signal` aborts or agent-fs
 * refuses it. Reconnects with `backoffDelay`, and waits exactly
 * `STREAM_BACKOFF_CAP_MS` after a 429 (agent-fs sends no `Retry-After` for
 * its stream cap). The returned promise settles when the stream stops for good.
 */
export async function openDriveStream(opts: DriveStreamOptions): Promise<void> {
  const { signal } = opts;
  let current: DriveStreamState | null = null;
  const setState = (next: DriveStreamState) => {
    if (signal.aborted || next === current) return;
    current = next;
    opts.onState(next);
  };
  let attempt = 0;
  const resetBackoff = () => {
    attempt = 0;
  };

  setState("connecting");
  while (!signal.aborted) {
    const status = await connectOnce(opts, setState, resetBackoff);
    if (signal.aborted) return;
    if (status !== null && status >= 400 && status < 500 && status !== 429) {
      setState("stopped");
      return;
    }
    const delay = status === 429 ? STREAM_BACKOFF_CAP_MS : backoffDelay(attempt, Math.random());
    attempt++;
    setState("retrying");
    await sleep(delay, signal);
  }
}

/**
 * One connection, read until it ends. Returns the HTTP status when agent-fs
 * answered with an error, and null when the stream ended, went quiet for
 * `STREAM_DEAD_MS`, sent an event larger than `SSE_MAX_PENDING` (the parser
 * throws), or the network failed.
 */
async function connectOnce(
  opts: DriveStreamOptions,
  setState: (state: DriveStreamState) => void,
  onHealthy: () => void,
): Promise<number | null> {
  const connection = new AbortController();
  const close = () => connection.abort();
  opts.signal.addEventListener("abort", close);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let healthyTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, STREAM_DEAD_MS);
  };

  try {
    armIdle();
    const body = await opts.client.openEvents(opts.orgId, opts.driveId, {
      signal: connection.signal,
    });
    const reader = body.getReader();
    // Closing ends a pending read, also for a body that ignores the fetch signal.
    const cancel = () => void reader.cancel().catch(() => {});
    if (connection.signal.aborted) cancel();
    else connection.signal.addEventListener("abort", cancel, { once: true });

    const parser = createSseParser((message) => {
      const event = toDriveEvent(message);
      if (!event || opts.signal.aborted) return;
      if (event.type === "ready") {
        setState("live");
        clearTimeout(healthyTimer);
        healthyTimer = setTimeout(onHealthy, STREAM_HEALTHY_MS);
      }
      opts.onEvent(event);
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done || connection.signal.aborted) return null;
      armIdle();
      parser.push(value);
    }
  } catch (error) {
    return error instanceof AgentFsError && error.status > 0 ? error.status : null;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(healthyTimer);
    opts.signal.removeEventListener("abort", close);
    connection.abort();
  }
}

const EVENT_TYPES = new Set<string>(["ready", "file.changed", "comment.changed"]);

/** A known event with a JSON object payload. Unknown events are skipped (newer servers). */
function toDriveEvent(message: SseMessage): DriveEvent | null {
  if (!EVENT_TYPES.has(message.event)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(message.data);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const event = { ...payload, type: message.event } as DriveEvent;
  if (event.type !== "ready" && typeof event.path !== "string") return null;
  return event;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
