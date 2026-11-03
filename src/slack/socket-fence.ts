import type { SocketModeClient } from "@slack/socket-mode";

/** Thrown inside a retired client when it tries to open a socket. Never escapes the client. */
export class SlackSocketClientRetiredError extends Error {
  constructor() {
    super("Slack socket-mode client was retired; it opens no new socket");
    this.name = "SlackSocketClientRetiredError";
  }
}

export interface SlackSocketFence {
  /** After this call, the client opens no new socket. Call it before the client is torn down. */
  retire: () => void;
  isRetired: () => boolean;
}

/**
 * Fence a socket-mode client so a reconnect still in flight at teardown can
 * never open a socket next to the replacement.
 *
 * `start()` awaits `apps.connections.open` (with up to 100 web-client retries)
 * before it builds the websocket, and it resets `shuttingDown` when it begins.
 * So `disconnect()` cannot stop a start that is already waiting for its URL.
 * The fence checks the retired flag before and after each URL request, and
 * `start()` then fails before it builds a websocket. A start that fails that
 * way resolves quietly: the library calls it from a reconnect with no catch.
 */
export function fenceSocketModeClient(client: SocketModeClient): SlackSocketFence {
  let retired = false;
  // retrieveWSSURL is private in the library's types, so reach it by name.
  const retrieveWSSURL: unknown = Reflect.get(client, "retrieveWSSURL");
  if (typeof retrieveWSSURL !== "function") {
    throw new Error("@slack/socket-mode changed: SocketModeClient.retrieveWSSURL is missing");
  }
  const start = client.start;

  Reflect.set(client, "retrieveWSSURL", async function (this: SocketModeClient) {
    if (retired) throw new SlackSocketClientRetiredError();
    const url: unknown = await retrieveWSSURL.call(this);
    if (retired) throw new SlackSocketClientRetiredError();
    return url;
  });
  Reflect.set(client, "start", function (this: SocketModeClient) {
    return start.call(this).catch((error: unknown) => {
      if (error instanceof SlackSocketClientRetiredError) return undefined;
      throw error;
    });
  });

  return {
    retire: () => {
      retired = true;
    },
    isRetired: () => retired,
  };
}
