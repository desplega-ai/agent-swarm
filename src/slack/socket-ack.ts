import type { App, SocketModeReceiver } from "@slack/bolt";
import {
  admitSlackInbound,
  createSlackInboundDrain,
  isSlackSocketEventStored,
  recordSlackSocketAckNotReady,
  recordSlackSocketEventRanInline,
} from "./inbound-dispatch";

/** @slack/socket-mode `sendWhileNotReadyError()`: the socket is down or reconnecting. */
const NOT_READY_MESSAGE = "Failed to send a WebSocket message as the client is not ready";

export function isSocketNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_READY_MESSAGE;
}

/**
 * Events whose effect is "last write wins". Run late from the drain they would
 * overwrite a newer event that already ran live, so they never wait in the queue.
 * They run inline and leave only a dedup-key tombstone behind.
 */
const ORDER_DEPENDENT_EVENTS = new Set(["assistant_thread_context_changed"]);

function isOrderDependentEvent(body: unknown): boolean {
  const type = (body as { event?: { type?: unknown } } | undefined)?.event?.type;
  return typeof type === "string" && ORDER_DEPENDENT_EVENTS.has(type);
}

type SocketAck = (response?: Record<string, unknown>) => Promise<void>;

interface SocketEnvelope {
  ack?: SocketAck;
  envelope_id?: string;
  type?: string;
  body?: unknown;
  retry_num?: number;
  retry_reason?: string;
}

interface SocketAckOptions {
  /** Called after a not-ready event was stored as a pending receipt: start the drain. */
  onAdmitted: () => void;
}

/**
 * Bolt acks an Events API delivery before it runs any middleware or listener,
 * and the receiver drops the event when that ack throws. A stalled event loop
 * can kill the socket between receive and ack, so the event is lost.
 *
 * Wrap the ack Bolt receives on each `slack_event`. When it fails only because
 * the socket is not ready, persist the event as a `pending` receipt (encrypted
 * payload plus dedup key, in one transaction) and wake the durable drain, which
 * hands it back to Bolt (`app.processEvent`) and records its outcome. Bolt's own
 * copy still drops, because the original error is rethrown. Work is persisted
 * before anything runs, so a crash or a failing middleware leaves a recoverable
 * receipt rather than a "processed" marker: a `pending` receipt is retried after
 * a restart, and a delivery that failed before any side effect is retried with
 * backoff. Only a crash mid-listener leaves it `uncertain`, which the drain
 * never replays, as for every durable delivery.
 *
 * If the receipt cannot be stored (store down, backlog full, no event id) the
 * ack error is swallowed instead and Bolt runs the listeners inline, deduped
 * only by the in-memory `event_id` cache: losing the event is the worse failure.
 * Order-dependent events (`assistant_thread_context_changed`, last write wins)
 * take that inline path by design: queued, an older one could run after a newer
 * one that ran live and overwrite it. Their dedup key is stored alongside, off
 * the ack path (Bolt runs the listener once the ack settles, so awaiting the
 * write would let a newer live event run first), with no payload and no way for
 * the drain to claim it. The in-memory cache is then not the only thing standing
 * between a redelivery and a restart: after one, an older context would
 * otherwise overwrite a newer one. A crash before that write lands loses only
 * this protection, and a redelivery in that window can run twice.
 * Any other ack error still throws.
 *
 * Slack redelivers the unacked event with the same `event_id` and a
 * `retry_num`. The redelivery is dropped before it reaches Bolt when its key is
 * stored, so the receipt stays the single owner of the work, also across a
 * restart. Only retries pay the lookup; first deliveries emit synchronously. If
 * the lookup fails the retry runs.
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
function tolerateSocketNotReadyAcks(
  client: SocketModeReceiver["client"],
  options: SocketAckOptions,
): void {
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
        const disposition = await dispose(payload, envelope);
        if (disposition === "drain") {
          options.onAdmitted();
          throw error; // Bolt drops its copy; the receipt carries the event.
        }
        if (disposition === "drop") throw error; // An earlier delivery already ran it.
        console.warn(
          `[Slack] socket ack failed (client not ready), processing inline: envelope_id=${envelope}`,
        );
      }
    };

    if (typeof payload.retry_num !== "number" || payload.retry_num < 1) {
      return deliver(event, args);
    }

    // A redelivery: drop it when a receipt already owns the event.
    void (async () => {
      let stored = false;
      try {
        stored = await isSlackSocketEventStored(payload.body);
      } catch (storeError) {
        console.warn("[Slack] could not check stored event key, processing:", storeError);
      }
      if (!stored) {
        deliver(event, args);
        return;
      }
      console.log(`[Slack] dropping redelivery of a stored event: envelope_id=${envelope}`);
      try {
        await ack();
      } catch (error) {
        console.warn("[Slack] ack of a dropped redelivery failed:", error);
      }
    })();
    return client.listenerCount(event) > 0;
  };
}

type Disposition =
  /** Stored as a pending receipt: the drain runs it. */
  | "drain"
  /** Its key was already stored: an earlier delivery owns it. */
  | "drop"
  /** Not stored for the drain (store failure, or order-dependent): Bolt runs it inline. */
  | "inline";

async function dispose(payload: SocketEnvelope, envelope: string): Promise<Disposition> {
  if (isOrderDependentEvent(payload.body)) {
    // Not awaited: Bolt runs the listener once the ack settles, so a slow or
    // blocked write would hold this event behind a newer one that ran live.
    void rememberInline(payload, envelope);
    return "inline";
  }
  try {
    const result = await admitSlackInbound({
      transport: "socket",
      kind: "event",
      rawBody: JSON.stringify(payload.body),
      body: payload.body,
      retryNum: payload.retry_num,
      retryReason: payload.retry_reason,
    });
    if (result.status === "admitted" || result.status === "duplicate") {
      console.warn(
        `[Slack] socket ack failed (client not ready), event stored for the drain: envelope_id=${envelope}`,
      );
      return "drain";
    }
    console.warn(
      `[Slack] could not store unacked event (${result.reason}): envelope_id=${envelope}`,
    );
  } catch (storeError) {
    console.warn("[Slack] could not persist unacked event:", storeError);
  }
  return "inline";
}

/**
 * An order-dependent event runs inline. Its key is stored alongside (no payload,
 * nothing for the drain to claim) so a redelivery after a restart is dropped
 * instead of overwriting a newer event that ran in between. The write is
 * best-effort and off the ack path: it never delays the event, and a store
 * failure only costs the restart protection, never the event.
 */
async function rememberInline(payload: SocketEnvelope, envelope: string): Promise<void> {
  try {
    const result = await recordSlackSocketEventRanInline(payload.body, {
      retryNum: payload.retry_num,
      retryReason: payload.retry_reason,
    });
    if (result === "duplicate") {
      console.warn(`[Slack] inline event key was already stored: envelope_id=${envelope}`);
    }
  } catch (storeError) {
    console.warn("[Slack] could not remember unacked inline event:", storeError);
  }
}

/**
 * Install the not-ready ack tolerance on the receiver's client and the durable
 * drain that runs the receipts it stores. The caller owns the drain: `wake()` it
 * after boot recovery to pick up receipts stored before a restart, `stop()` it
 * on shutdown.
 */
export function installSocketAckRecovery(
  client: SocketModeReceiver["client"],
  app: Pick<App, "processEvent">,
): ReturnType<typeof createSlackInboundDrain> {
  const drain = createSlackInboundDrain(
    async ({ receipt, rawBody }) => {
      await app.processEvent({
        body: JSON.parse(rawBody),
        ack: async () => {},
        retryNum: receipt.retryNum ?? undefined,
        retryReason: receipt.retryReason ?? undefined,
      });
    },
    { requireBoltDispatch: true },
  );
  tolerateSocketNotReadyAcks(client, { onAdmitted: () => void drain.wake() });
  return drain;
}
