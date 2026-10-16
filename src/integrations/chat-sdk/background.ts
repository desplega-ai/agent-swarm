import { scrubSecrets } from "@/utils/secret-scrubber";

/**
 * In-process `waitUntil` for Chat SDK webhooks. The SDK hands handler work to
 * `waitUntil` and answers the platform immediately; this tracker keeps that
 * work visible so shutdown can drain it before the DB closes.
 */
const inFlight = new Set<Promise<unknown>>();

/** The `waitUntil` implementation: track, and scrub-log any rejection. */
export function trackBackground(task: Promise<unknown>): void {
  const tracked = task.then(
    () => undefined,
    (error: unknown) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[chat-sdk] Background handler failed:", scrubSecrets(message));
    },
  );
  inFlight.add(tracked);
  void tracked.finally(() => inFlight.delete(tracked));
}

/** Await in-flight work, bounded by `timeoutMs`. Returns true when fully drained. */
export async function drainBackground(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const drained = Promise.all([...inFlight]).then(() => true as const);
  try {
    return await Promise.race([drained, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
