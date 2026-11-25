import { realtimeBus } from "../realtime/bus";
import { channelTopic } from "../realtime/channels";

/** The `app:<appId>` channel open app surfaces subscribe to (`rows` events). */
export function appChannelNamespace(appId: string): string {
  return `app:${appId}`;
}

/** Coalescing window: a sync pass that writes many rows sends one event per model. */
export const APP_ROWS_EVENT_DELAY_MS = 250;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Tell open surfaces of `appId` that rows of `model` changed, so they refetch
 * the queries over it now instead of at the next poll. Carries no row data:
 * the refetch goes through the normal, permission-checked query route.
 * shortcut: in-process bus, one API replica (as all realtime); a multi-replica deploy needs a shared bus.
 */
export function publishAppRowsChanged(appId: string, model: string): void {
  const key = `${appId}\u0000${model}`;
  if (pending.has(key)) return;
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      realtimeBus.publish(channelTopic(appChannelNamespace(appId), "rows"), { model });
    }, APP_ROWS_EVENT_DELAY_MS),
  );
}
