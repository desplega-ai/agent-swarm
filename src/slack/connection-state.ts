/**
 * Live Socket Mode connection state, fed by the SocketModeClient lifecycle
 * events in `app.ts` and read by `/status` to decide whether Slack is
 * `verified`. Kept in its own module so status code can read it without
 * importing the Bolt app (several tests mock `./app`).
 */
export type SlackConnectionState = "disconnected" | "connecting" | "connected";

let state: SlackConnectionState = "disconnected";
let lastConnectedAt: Date | null = null;

export function getSlackConnectionState(): SlackConnectionState {
  return state;
}

/** When the socket last reached `connected` in this process, or null if never. */
export function getSlackLastConnectedAt(): Date | null {
  return lastConnectedAt;
}

export function setSlackConnectionState(next: SlackConnectionState): void {
  state = next;
  if (next === "connected") lastConnectedAt = new Date();
}
