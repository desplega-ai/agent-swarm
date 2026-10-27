import type { SocketModeReceiver } from "@slack/bolt";
import {
  recordSlackSocketAckNotReady,
  recordSlackSocketUnackedEvent,
  wasSlackSocketEventUnacked,
} from "./inbound-dispatch";

/** @slack/socket-mode `sendWhileNotReadyError()`: the socket is down or reconnecting. */
const NOT_READY_MESSAGE = "Failed to send a WebSocket message as the client is not ready";

export function isSocketNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_READY_MESSAGE;
}

type SocketAck = (response?: Record<string, unknown>) => Promise<void>;

interface SocketEnvelope {
  ack?: SocketAck;
  envelope_id?: string;
  type?: string;
  body?: unknown;
  retry_num?: number;
}

/**
 * Bolt acks an Events API delivery before it runs any middleware or listener,
 * and the receiver drops the event when that ack throws. A stalled event loop
 * can kill the socket between receive and ack, so the event is lost.
 *
 * Wrap the ack Bolt receives on each `slack_event`: when it fails only because
 * the socket is not ready, persist the event's dedup key, log and count it,
 * and let the listeners run. Any other ack error still throws.
 *
 * Slack redelivers the unacked event with the same `event_id` and a
 * `retry_num`. The redelivery is dropped before it reaches Bolt when its key is
 * stored, so it never reaches a listener: not the message handler, not an
 * assistant callback that would overwrite newer thread context with a stale
 * one, and not after a restart, which clears the listeners' in-memory
 * `wasEventSeen` cache but not the stored key. The stored key lives as long as
 * the other completed receipts (48h, past Slack's 24h delayed-retry window).
 * Only retries pay the lookup; first deliveries emit synchronously. If the
 * store is unreachable the event runs anyway: losing it is the worse failure.
 *
 * Only `events_api` envelopes are wrapped. Interactive payloads (modal
 * submissions, button actions) and slash commands ack from inside their
 * handler, which does the work after acking: swallowing a failed ack there
 * would run the handler while Slack shows the user an error, and the retry
 * would run it again.
 *
 * Wrapping `emit` (public) is the narrowest hook: the receiver builds its own
 * client and reads `args.ack` when its `slack_event` listener runs.
 */
export function tolerateSocketNotReadyAcks(client: SocketModeReceiver["client"]): void {
  const emit = client.emit.bind(client);
  const deliver = (event: string | symbol, args: unknown[]) => emit(event, ...args);

  client.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    const payload = args[0] as SocketEnvelope | undefined;
    if (
      event !== "slack_event" ||
      payload?.type !== "events_api" ||
      typeof payload.ack !== "function"
    ) {
      return deliver(event, args);
    }

    const ack = payload.ack;
    const envelope = payload.envelope_id ?? "unknown";
    payload.ack = async (response) => {
      try {
        await ack(response);
      } catch (error) {
        if (!isSocketNotReadyError(error)) throw error;
        recordSlackSocketAckNotReady();
        try {
          await recordSlackSocketUnackedEvent(payload.body);
        } catch (storeError) {
          console.warn("[Slack] could not persist unacked event key:", storeError);
        }
        console.warn(
          `[Slack] socket ack failed (client not ready), processing anyway: envelope_id=${envelope}`,
        );
      }
    };

    if (typeof payload.retry_num !== "number" || payload.retry_num < 1) {
      return deliver(event, args);
    }

    // A redelivery: drop it when the original already ran without an ack.
    void (async () => {
      let alreadyRan = false;
      try {
        alreadyRan = await wasSlackSocketEventUnacked(payload.body);
      } catch (storeError) {
        console.warn("[Slack] could not check unacked event key, processing:", storeError);
      }
      if (!alreadyRan) {
        deliver(event, args);
        return;
      }
      console.log(
        `[Slack] dropping redelivery of an event that ran unacked: envelope_id=${envelope}`,
      );
      try {
        await ack();
      } catch (error) {
        console.warn("[Slack] ack of a dropped redelivery failed:", error);
      }
    })();
    return client.listenerCount(event) > 0;
  };
}
