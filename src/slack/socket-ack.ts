import type { SocketModeReceiver } from "@slack/bolt";
import { recordSlackSocketAckNotReady } from "./inbound-dispatch";

/** @slack/socket-mode `sendWhileNotReadyError()`: the socket is down or reconnecting. */
const NOT_READY_MESSAGE = "Failed to send a WebSocket message as the client is not ready";

export function isSocketNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_READY_MESSAGE;
}

type SocketAck = (response?: Record<string, unknown>) => Promise<void>;

/**
 * Bolt acks an Events API delivery before it runs any middleware or listener,
 * and the receiver drops the event when that ack throws. A stalled event loop
 * can kill the socket between receive and ack, so the event is lost.
 *
 * Wrap the ack Bolt receives on each `slack_event`: when it fails only because
 * the socket is not ready, log and count it, and let the listeners run. Slack
 * redelivers the unacked event with the same `event_id`, and the listeners'
 * in-memory dedup (`wasEventSeen`) drops that retry. Any other ack error
 * still throws.
 *
 * Only `events_api` envelopes are wrapped. Interactive payloads (modal
 * submissions, button actions) and slash commands ack from inside their
 * handler, which does the work after acking: swallowing a failed ack there
 * would run the handler while Slack shows the user an error, and the retry
 * would run it again. Every non-idempotent Events API listener must dedupe on
 * `event_id` (`wasEventSeen`), because the redelivery reaches it.
 *
 * Wrapping `emit` (public) is the narrowest hook: the receiver builds its own
 * client and reads `args.ack` when its `slack_event` listener runs.
 */
export function tolerateSocketNotReadyAcks(client: SocketModeReceiver["client"]): void {
  const emit = client.emit.bind(client);
  client.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    const payload = args[0] as { ack?: SocketAck; envelope_id?: string; type?: string } | undefined;
    if (
      event === "slack_event" &&
      payload?.type === "events_api" &&
      typeof payload.ack === "function"
    ) {
      const ack = payload.ack;
      payload.ack = async (response) => {
        try {
          await ack(response);
        } catch (error) {
          if (!isSocketNotReadyError(error)) throw error;
          recordSlackSocketAckNotReady();
          console.warn(
            `[Slack] socket ack failed (client not ready), processing anyway: envelope_id=${payload.envelope_id ?? "unknown"}`,
          );
        }
      };
    }
    return emit(event, ...args);
  };
}
