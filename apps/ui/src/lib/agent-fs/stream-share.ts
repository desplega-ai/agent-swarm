// One change stream per browser for a drive on an `http:` agent-fs.
//
// Over HTTP/1.1 a browser opens at most 6 connections per host, and an open
// stream holds one for as long as it lives. With one stream per tab, a few
// Comb tabs leave no connection for agent-fs requests. So the tabs elect one
// leader per drive with `navigator.locks`: the lock holder opens the stream
// and relays its state and events through a `BroadcastChannel`. The other
// tabs follow: they apply the relayed events, and they poll while the leader
// is not live. When the leader closes (tab closed or hidden, drive changed),
// the next tab in the lock queue takes over and opens its own stream.
// HTTPS endpoints (HTTP/2) do not need this: all streams share one connection.

import {
  type DriveEvent,
  type DriveStreamOptions,
  type DriveStreamState,
  openDriveStream,
} from "./stream";

/** The `navigator.locks.request` form the election uses. */
export interface LockRequester {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

/** The `BroadcastChannel` parts the relay uses. */
export interface RelayChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface StreamShare {
  /** The lock and channel name: one per endpoint, user, and drive. */
  name: string;
  locks: LockRequester;
  openChannel: (name: string) => RelayChannel;
}

/** The browser's lock manager and channels. Null where either is missing (Web Locks need a secure context). */
export function browserStreamShare(name: string): StreamShare | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  if (typeof BroadcastChannel === "undefined") return null;
  const { locks } = navigator;
  return {
    name,
    locks: { request: (lockName, options, callback) => locks.request(lockName, options, callback) },
    openChannel: (channelName) => new BroadcastChannel(channelName),
  };
}

type RelayMessage =
  | { type: "hello" }
  | { type: "state"; state: DriveStreamState }
  | { type: "event"; event: DriveEvent };

export interface SharedStreamOptions extends Omit<DriveStreamOptions, "onState"> {
  /** `relayed`: the state is the leader tab's stream, and this tab follows it. */
  onState: (state: DriveStreamState, relayed: boolean) => void;
  /** Null: this tab opens its own stream. */
  share: StreamShare | null;
}

/**
 * `openDriveStream`, shared by the tabs of one browser when `share` is set.
 * A follower gets the leader's states and events. When the relayed state
 * turns `live`, the follower also gets a local `ready` event, because it
 * missed the events before it joined. Settles when `signal` aborts.
 */
export async function openSharedDriveStream(opts: SharedStreamOptions): Promise<void> {
  const { share, signal } = opts;
  const ownStream = () =>
    openDriveStream({ ...opts, onState: (state) => opts.onState(state, false) });
  if (!share) return ownStream();

  const channel = share.openChannel(share.name);
  const post = (message: RelayMessage) => {
    if (!signal.aborted) channel.postMessage(message);
  };
  let leading = false;
  let ownState: DriveStreamState | null = null;
  let relayed: DriveStreamState | null = null;
  const onMessage = ({ data }: MessageEvent) => {
    const message = data as RelayMessage;
    if (signal.aborted) return;
    if (leading) {
      if (message.type === "hello" && ownState) post({ type: "state", state: ownState });
      return;
    }
    if (message.type === "state" && message.state !== relayed) {
      const wasLive = relayed === "live";
      relayed = message.state;
      opts.onState(message.state, true);
      if (message.state === "live" && !wasLive) {
        opts.onEvent({ type: "ready", driveId: opts.driveId, at: new Date().toISOString() });
      }
    } else if (message.type === "event" && relayed === "live") {
      opts.onEvent(message.event);
    }
  };
  channel.addEventListener("message", onMessage);

  try {
    post({ type: "hello" });
    await share.locks.request(share.name, { signal }, async () => {
      leading = true;
      await openDriveStream({
        ...opts,
        onState: (state) => {
          ownState = state;
          opts.onState(state, false);
          post({ type: "state", state });
        },
        onEvent: (event) => {
          opts.onEvent(event);
          // Followers resync on the `live` state instead.
          if (event.type !== "ready") post({ type: "event", event });
        },
      });
      // A refused stream (`stopped`) keeps the lock: agent-fs would refuse the other tabs too.
      await abortedPromise(signal);
    });
  } catch {
    // The signal aborted while this tab waited for the lock, or the browser
    // refused the lock. In the second case, stream alone.
    if (!signal.aborted && !leading) {
      channel.removeEventListener("message", onMessage);
      await ownStream();
    }
  } finally {
    channel.removeEventListener("message", onMessage);
    channel.close();
  }
}

function abortedPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
