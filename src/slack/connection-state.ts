/**
 * Live Socket Mode connection state, fed by the SocketModeClient lifecycle
 * events in `app.ts` and read by `/status` to decide whether Slack is
 * `verified`. Kept in its own module so status code can read it without
 * importing the Bolt app (several tests mock `./app`).
 */
export type SlackConnectionState = "disconnected" | "connecting" | "connected";

let state: SlackConnectionState = "disconnected";

export function getSlackConnectionState(): SlackConnectionState {
  return state;
}

export function setSlackConnectionState(next: SlackConnectionState): void {
  state = next;
}
