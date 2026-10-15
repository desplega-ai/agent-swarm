import type { DiscordAdapter } from "@chat-adapter/discord";
import type { Adapter } from "chat";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { trackBackground } from "./background";
import { errorMessage } from "./logger";

/**
 * Discord sends channel messages and mentions only over the Gateway WebSocket.
 * The adapter's `startGatewayListener` listens for one window and then
 * destroys its client (it is built for serverless re-invocation), so a
 * long-lived API process re-arms it in a loop. The adapter has no
 * `disconnect()`, so `chat.shutdown()` does not stop the Gateway; aborting
 * this loop is the only stop path.
 *
 * The Gateway does not replay `MESSAGE_CREATE`: messages sent during a re-arm
 * gap or a backoff are lost. A long window keeps gaps rare. 6 h uses 4
 * identifies per day of Discord's 1000.
 */
const DISCORD_GATEWAY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** A window that ends sooner than this failed (bad token, network down). */
const MIN_HEALTHY_WINDOW_MS = 10_000;
const BACKOFF_MS = 30_000;
/** Bound on the response body text logged when the listener refuses to start. */
const MAX_LOGGED_BODY_CHARS = 200;

export interface DiscordGatewayHealth {
  state: "running" | "backoff" | "stopped";
  since: string;
  /** Re-arms after the first listener window. */
  restarts: number;
}

/** The part of the Discord adapter the loop uses. */
export type DiscordGatewayListener = Pick<DiscordAdapter, "startGatewayListener">;

export function isDiscordGatewayListener(
  adapter: Adapter,
): adapter is Adapter & DiscordGatewayListener {
  return "startGatewayListener" in adapter && typeof adapter.startGatewayListener === "function";
}

/** Test seams. Production uses the defaults. */
export interface DiscordGatewayOptions {
  windowMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

let current: { controller: AbortController; loop: Promise<void>; now: () => number } | undefined;
let health: DiscordGatewayHealth | undefined;

function setState(state: DiscordGatewayHealth["state"], restarts: number, nowMs: number): void {
  if (health?.state === state) {
    health = { ...health, restarts };
    return;
  }
  health = { state, since: new Date(nowMs).toISOString(), restarts };
}

async function runGatewayLoop(
  adapter: DiscordGatewayListener,
  signal: AbortSignal,
  options: DiscordGatewayOptions,
): Promise<void> {
  const windowMs = options.windowMs ?? DISCORD_GATEWAY_WINDOW_MS;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  let restarts = 0;
  let first = true;
  while (!signal.aborted) {
    if (!first) restarts += 1;
    first = false;
    setState("running", restarts, now());
    const started = now();
    let inner: Promise<unknown> | undefined;
    // One controller per window. The adapter adds an `abort` listener to the
    // signal it gets and never removes it, so passing the outer signal would
    // leak one listener (and the destroyed client) per re-arm.
    const windowController = new AbortController();
    const abortWindow = (): void => windowController.abort();
    signal.addEventListener("abort", abortWindow, { once: true });
    try {
      const response = await adapter.startGatewayListener(
        {
          waitUntil: (task) => {
            inner = task;
            trackBackground(task);
          },
        },
        windowMs,
        windowController.signal,
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(
          scrubSecrets(
            `[chat-sdk] discord gateway listener refused to start: HTTP ${response.status}: ${body.slice(0, MAX_LOGGED_BODY_CHARS)}`,
          ),
        );
      }
      // The inner promise resolves when the window ends or on abort. It never
      // rejects: login errors are logged by the adapter and end the window.
      await inner;
    } catch (error) {
      console.error(
        scrubSecrets(`[chat-sdk] discord gateway listener failed: ${errorMessage(error)}`),
      );
    } finally {
      signal.removeEventListener("abort", abortWindow);
    }
    const elapsed = now() - started;
    if (signal.aborted) break;
    if (elapsed < MIN_HEALTHY_WINDOW_MS) {
      setState("backoff", restarts, now());
      console.warn(
        scrubSecrets(
          `[chat-sdk] discord gateway backoff: window ended after ${elapsed}ms, retrying in ${BACKOFF_MS / 1000}s`,
        ),
      );
      await sleep(BACKOFF_MS, signal);
    }
  }
}

/**
 * Start the supervised Gateway loop. Call only after `chat.initialize()`
 * succeeded: the listener refuses to start before that.
 */
export function startDiscordGateway(
  adapter: DiscordGatewayListener,
  options: DiscordGatewayOptions = {},
): void {
  if (current) return;
  const now = options.now ?? Date.now;
  health = { state: "running", since: new Date(now()).toISOString(), restarts: 0 };
  const controller = new AbortController();
  const loop = runGatewayLoop(adapter, controller.signal, options).catch((error: unknown) => {
    console.error(`[chat-sdk] discord gateway loop crashed: ${errorMessage(error)}`);
  });
  current = { controller, loop, now };
}

/**
 * Abort the loop and return at once. The open window is tracked by
 * `trackBackground`, so the shutdown drain bounds the wait for it to close.
 * The `stopped` state and log line follow when the loop exits.
 */
export function stopDiscordGateway(): void {
  if (!current) return;
  const { controller, loop, now } = current;
  current = undefined;
  controller.abort();
  void loop.then(() => {
    // Skip when a new loop started, or when shutdown already reset health.
    if (!current && health) setState("stopped", health.restarts, now());
    console.log("[chat-sdk] discord gateway stopped");
  });
}

export function getDiscordGatewayHealth(): DiscordGatewayHealth | undefined {
  return health;
}

/** Forget the gateway record. Runtime shutdown clears adapter health the same way. */
export function resetDiscordGatewayHealth(): void {
  health = undefined;
}
