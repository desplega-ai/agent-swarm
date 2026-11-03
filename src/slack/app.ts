import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { emitBuiltInIntegrationConnectedOnce, ensureSlackRenderV2Activation } from "../be/db";
import { getNodeEnv } from "../utils/node-env";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getSlackConfiguration } from "./config";
import {
  getSlackConnectionState,
  type SlackConnectionState,
  setSlackConnectionState,
} from "./connection-state";
import { installSlackEgressScrub } from "./egress-scrub";
import { installSlackExternalChannelGuard } from "./external-channel-egress";
import { recoverSlackInboundAfterRestart, slackInboundOutcomeMiddleware } from "./inbound-dispatch";
import { isSlackLifecycleBusy, runSlackLifecycleExclusive } from "./lifecycle-lock";
import { installSocketAckRecovery } from "./socket-ack";
import { fenceSocketModeClient, type SlackSocketFence } from "./socket-fence";
import { getSlackSocketModeBlockReason, SLACK_DEV_SOCKET_MODE_OPT_IN } from "./socket-mode-guard";
import { startTaskWatcher, stopTaskWatcher } from "./watcher";

let app: App | null = null;
let receiver: SocketModeReceiver | null = null;
let initialized = false;
let inboundDrain: ReturnType<typeof installSocketAckRecovery> | null = null;
// Retires the current client at teardown, so a reconnect it still has in
// flight cannot open a socket next to the replacement.
let socketFence: SlackSocketFence | null = null;
// Bumped at each teardown. A start that sees a new generation was abandoned
// by the watchdog (or overtaken by a stop) and must not touch shared state.
let lifecycleGeneration = 0;
// Last sign of life on the current socket: Slack's hello or any envelope.
let lastSocketActivityAt: number | null = null;

const SOCKET_EVENT_STATES: Record<string, SlackConnectionState> = {
  connecting: "connecting",
  reconnecting: "connecting",
  connected: "connected",
  disconnecting: "disconnected",
  disconnected: "disconnected",
};

function trackConnectionState(owner: SocketModeReceiver): void {
  for (const [event, state] of Object.entries(SOCKET_EVENT_STATES)) {
    owner.client.on(event, () => {
      // Ignore late events from a receiver that stopSlackApp() already replaced.
      if (receiver !== owner) return;
      setSlackConnectionState(state);
      if (state === "connected") lastSocketActivityAt = Date.now();
    });
  }
  owner.client.on("slack_event", () => {
    if (receiver === owner) lastSocketActivityAt = Date.now();
  });
}

// ─── Socket watchdog ──────────────────────────────────────────────────────────
// @slack/socket-mode treats a RequestError/HTTPError from apps.connections.open
// as unrecoverable during a reconnect, and its reconnect promise has no catch.
// The client then stops retrying for good and the state sticks in
// `connecting`. Upstream will not fix it (slackapi/node-slack-sdk#2656), so the
// watchdog rebuilds the whole Slack app when the socket stays down.

export interface SlackSocketWatchdogOptions {
  /** How often the watchdog checks the socket. */
  tickMs: number;
  /** How long the socket must be down before the first restart. */
  downAfterMs: number;
  /** With no hello or envelope for this long, a `connected` socket also needs `isActive()`. */
  staleActivityMs: number;
  /** Delay after the first restart; it doubles after each further attempt. */
  backoffBaseMs: number;
  /** Cap on the delay between restarts. */
  backoffMaxMs: number;
  /**
   * Bound on one restart (teardown + start) under the lifecycle lock. A
   * restart still running then is abandoned, so a config reload or a shutdown
   * waiting on the lock gets it.
   */
  restartTimeoutMs: number;
  /**
   * Bound on stopSlackApp()'s wait for the lifecycle lock. Shutdown must
   * finish inside the pod's termination grace, which is shorter than
   * `restartTimeoutMs`.
   */
  stopLockWaitMs: number;
}

export const SLACK_SOCKET_WATCHDOG_DEFAULTS: SlackSocketWatchdogOptions = {
  tickMs: 5_000,
  downAfterMs: 60_000,
  staleActivityMs: 10 * 60_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 5 * 60_000,
  restartTimeoutMs: 2 * 60_000,
  stopLockWaitMs: 10_000,
};

export interface SlackSocketWatchdogDeps {
  now: () => number;
  getState: () => SlackConnectionState;
  /** Last hello or envelope on the current socket, in epoch ms. */
  getLastActivityAt: () => number | null;
  /** The socket-mode client's own view: is its websocket open? */
  isSocketActive: () => boolean;
  /** True while a config reload (or another restart) holds the Slack lifecycle lock. */
  isLifecycleBusy: () => boolean;
  restart: () => Promise<void>;
  log: (line: string) => void;
}

export interface SlackSocketWatchdog {
  tick: () => Promise<void>;
  /** Restart attempts since the socket was last healthy. */
  attempts: () => number;
}

/** Delay before restart attempt `attempt + 1`: base * 2^(attempt-1), capped. */
export function slackWatchdogBackoffMs(
  attempt: number,
  options: SlackSocketWatchdogOptions,
): number {
  return Math.min(options.backoffBaseMs * 2 ** Math.max(0, attempt - 1), options.backoffMaxMs);
}

/**
 * The watchdog state machine, with no timers of its own: the caller drives
 * `tick()`. Operators search the two log lines, so keep their
 * text stable.
 */
export function createSlackSocketWatchdog(
  deps: SlackSocketWatchdogDeps,
  options: SlackSocketWatchdogOptions = SLACK_SOCKET_WATCHDOG_DEFAULTS,
): SlackSocketWatchdog {
  let downSince: number | null = null;
  let attempts = 0;
  let nextAttemptAt = 0;
  let restarting = false;

  function isHealthy(now: number): boolean {
    if (deps.getState() !== "connected") return false;
    // A quiet night is normal. Only a quiet socket that the client itself
    // reports as closed counts as down.
    const lastActivityAt = deps.getLastActivityAt();
    if (lastActivityAt === null || now - lastActivityAt < options.staleActivityMs) return true;
    return deps.isSocketActive();
  }

  async function tick(): Promise<void> {
    if (restarting || deps.isLifecycleBusy()) return;
    const now = deps.now();
    if (isHealthy(now)) {
      if (attempts > 0 && downSince !== null) {
        deps.log(`[Slack] watchdog: recovered after ${seconds(now - downSince)}s`);
      }
      downSince = null;
      attempts = 0;
      nextAttemptAt = 0;
      return;
    }
    downSince ??= now;
    if (now - downSince < options.downAfterMs || now < nextAttemptAt) return;
    attempts += 1;
    nextAttemptAt = now + slackWatchdogBackoffMs(attempts, options);
    deps.log(
      `[Slack] watchdog: socket down for ${seconds(now - downSince)}s, restarting (attempt ${attempts})`,
    );
    restarting = true;
    try {
      await deps.restart();
    } catch (error) {
      // The error can carry request config or a token; scrub before it leaves.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Slack] watchdog: restart failed: ${scrubSecrets(message)}`);
    } finally {
      restarting = false;
    }
  }

  return { tick, attempts: () => attempts };
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function isLiveSocketActive(): boolean {
  return receiver?.client.websocket?.isActive() ?? false;
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogOptions: SlackSocketWatchdogOptions = SLACK_SOCKET_WATCHDOG_DEFAULTS;

/**
 * Rebuild the Slack app under the lifecycle lock, bounded by
 * `restartTimeoutMs`. The web client can retry apps.connections.open for many
 * minutes, and every config reload waits on the lock meanwhile. A restart
 * that runs out of time is abandoned: its client is retired first, so it can
 * never open a socket later, and the watchdog tries again after its backoff.
 */
async function restartSlackAppForWatchdog(owner: ReturnType<typeof setInterval>): Promise<void> {
  await runSlackLifecycleExclusive(async () => {
    // stopSlackApp() won the lock first and disarmed this watchdog (shutdown,
    // or a reload that armed a new one). Restarting now would bring back an
    // app that the caller already stopped.
    if (watchdogTimer !== owner) return;
    // A config reload that won the lock may have just brought the socket back.
    if (getSlackConnectionState() === "connected" && isLiveSocketActive()) return;
    let abandoned = false;
    const restart = (async () => {
      await teardownSlackApp();
      // A teardown that outlived the timeout must not start an app outside the
      // lock, and one that a forced stopSlackApp() disarmed must not start one at all.
      if (!abandoned && watchdogTimer === owner) await startSlackApp();
    })();
    const timeoutMs = watchdogOptions.restartTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    try {
      const outcome = await Promise.race([restart.then(() => false as const), timedOut]);
      if (!outcome) return;
    } finally {
      clearTimeout(timer);
    }
    abandoned = true;
    // The abandoned restart settles later, if ever; its error is no longer news.
    void restart.catch(() => {});
    abandonSlackApp();
    throw new Error(`restart did not finish within ${seconds(timeoutMs)}s; abandoned it`);
  });
}

function startSocketWatchdog(): void {
  if (watchdogTimer) return;
  let timer: ReturnType<typeof setInterval> | null = null;
  const watchdog = createSlackSocketWatchdog(
    {
      now: Date.now,
      getState: getSlackConnectionState,
      getLastActivityAt: () => lastSocketActivityAt,
      isSocketActive: isLiveSocketActive,
      isLifecycleBusy: isSlackLifecycleBusy,
      restart: () => (timer ? restartSlackAppForWatchdog(timer) : Promise.resolve()),
      log: (line) => console.log(line),
    },
    watchdogOptions,
  );
  timer = setInterval(() => {
    if (getSlackConfiguration().mode !== "socket") {
      stopSocketWatchdog();
      return;
    }
    void watchdog.tick();
  }, watchdogOptions.tickMs);
  // Never keep the process (or a test run) alive for the watchdog alone.
  timer.unref?.();
  watchdogTimer = timer;
}

function stopSocketWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

/** Test hook: shorter thresholds for the next watchdog start. Pass nothing to reset. */
export function _setSlackSocketWatchdogOptionsForTests(
  options?: Partial<SlackSocketWatchdogOptions>,
): void {
  watchdogOptions = { ...SLACK_SOCKET_WATCHDOG_DEFAULTS, ...options };
}

/** Test hook: the live socket-mode client, to inject reconnect faults. */
export function _getSlackSocketClientForTests(): SocketModeReceiver["client"] | null {
  return receiver?.client ?? null;
}

export function isSlackSocketWatchdogRunning(): boolean {
  return watchdogTimer !== null;
}

export function getSlackApp(): App | null {
  return app;
}

export async function initSlackApp(): Promise<App | null> {
  // Prevent double initialization
  if (initialized) {
    console.log("[Slack] Already initialized, skipping");
    return app;
  }
  const config = getSlackConfiguration();
  if (config.disabled) {
    console.log("[Slack] Disabled via SLACK_DISABLE");
    return null;
  }

  if (!config.mode) {
    console.error(
      "[Slack] Invalid SLACK_MODE; expected socket or http. Slack integration disabled",
    );
    return null;
  }

  if (config.missingCredentials.length > 0) {
    console.log(
      `[Slack] Missing ${config.missingCredentials.join(" or ")} for ${config.mode} mode, Slack integration disabled`,
    );
    return null;
  }

  // Phase 1 establishes the transport contract only. Never fall back to a
  // socket when HTTP was explicitly selected; the receiver lands in Phase 3.
  if (config.mode === "http") {
    console.error(
      "[Slack] HTTP mode is configured but unavailable until the HTTP receiver is installed",
    );
    return null;
  }

  const botToken = process.env.SLACK_BOT_TOKEN as string;
  const appToken = process.env.SLACK_APP_TOKEN as string;

  const socketModeBlockReason = getSlackSocketModeBlockReason(process.env);
  if (socketModeBlockReason) {
    console.error(
      `[Slack] SOCKET MODE BLOCKED: ${socketModeBlockReason}. Set ${SLACK_DEV_SOCKET_MODE_OPT_IN}=true to opt in explicitly.`,
    );
    return null;
  }

  // Every client Bolt builds from here on scrubs outbound text and refuses
  // writes to external channels when SLACK_BLOCK_EXTERNAL_CHANNELS is on.
  installSlackEgressScrub();
  installSlackExternalChannelGuard();

  // SLACK_API_URL points Bolt (Web API and apps.connections.open) at a mock Slack server for e2e tests.
  const slackApiUrl = process.env.SLACK_API_URL;
  const clientOptions = slackApiUrl ? { slackApiUrl } : undefined;
  const logLevel = getNodeEnv() === "development" ? LogLevel.DEBUG : LogLevel.INFO;
  // Build the receiver ourselves so its SocketModeClient lifecycle events can
  // feed /status. Bolt would otherwise forward clientOptions via installerOptions.
  receiver = new SocketModeReceiver({
    appToken,
    logLevel,
    installerOptions: clientOptions ? { clientOptions } : {},
  });
  trackConnectionState(receiver);
  socketFence = fenceSocketModeClient(receiver.client);
  app = new App({
    token: botToken,
    receiver,
    socketMode: true,
    logLevel,
    ...(clientOptions ? { clientOptions } : {}),
  });

  // Events whose Socket Mode ack failed are stored as receipts; the drain hands
  // them back to Bolt, so a crash or a failing listener leaves recoverable work.
  inboundDrain = installSocketAckRecovery(receiver.client, app);

  // Failed validation must remain retryable without requiring stopSlackApp().
  initialized = true;

  // First global middleware: every handler below runs inside it, so each
  // delivery resolves to an explicit processed/ignored/failed/uncertain outcome.
  app.use(slackInboundOutcomeMiddleware());

  // Register handlers
  const { registerMessageHandler } = await import("./handlers");
  const { registerCommandHandler } = await import("./commands");
  const { registerActionHandlers } = await import("./actions");
  const { registerWorkObjectHandlers } = await import("./work-objects");

  registerMessageHandler(app);
  registerCommandHandler(app);
  registerActionHandlers(app);
  registerWorkObjectHandlers(app);

  // Register assistant thread handler (safe even if "Agents & AI Apps" isn't enabled)
  const { createAssistant } = await import("./assistant");
  app.assistant(createAssistant());

  // Report-only scan for external (Slack Connect) channels the bot is already in.
  const { isBlockExternalEnabled, scanExternalChannelsOnBoot } = await import("./external-channel");
  if (isBlockExternalEnabled()) {
    scanExternalChannelsOnBoot(app.client).catch((error) => {
      console.error("[Slack] External channel boot scan failed:", error);
    });
  }

  return app;
}

export async function startSlackApp(): Promise<boolean> {
  const generation = lifecycleGeneration;
  if (!app) {
    await initSlackApp();
  }

  const current = app;
  if (current && generation === lifecycleGeneration) {
    // Arm before app.start(): a start that throws is retried by the watchdog.
    startSocketWatchdog();
    // Establish the durable cutoff before Socket Mode can deliver new asks.
    const { isSlackRenderV2Enabled } = await import("./render-v2");
    if (isSlackRenderV2Enabled()) await ensureSlackRenderV2Activation();
    // Receipts stored before the last restart: interrupted ones turn uncertain,
    // pending ones are processed once the app can dispatch them.
    await recoverSlackInboundAfterRestart();
    if (generation !== lifecycleGeneration) return false;
    await current.start();
    // Abandoned while it waited: the app was already detached and retired.
    if (generation !== lifecycleGeneration) return false;
    console.log("[Slack] Bot connected via Socket Mode");
    void inboundDrain?.wake();
    await emitBuiltInIntegrationConnectedOnce("slack");

    // Start watching for task completions
    await startTaskWatcher();
    return true;
  }

  return false;
}

/**
 * Stop the app and disarm the watchdog. Takes the Slack lifecycle lock, so a
 * watchdog restart in flight finishes first and cannot bring the app back
 * after this returns. The wait for the lock is bounded by `stopLockWaitMs`:
 * after that, the stop disarms the watchdog and drops the app without the
 * lock, and stops again once the lock frees.
 */
export async function stopSlackApp(): Promise<void> {
  const locked = runSlackLifecycleExclusive(stopSlackAppUnderLifecycleLock);
  const waitMs = watchdogOptions.stopLockWaitMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), waitMs);
  });
  try {
    const outcome = await Promise.race([locked.then(() => false as const), timedOut]);
    if (!outcome) return;
  } finally {
    clearTimeout(timer);
  }
  // The late stop under the lock still runs; its error is no longer news.
  void locked.catch(() => {});
  console.error(
    `[Slack] stop: lifecycle lock still held after ${seconds(waitMs)}s; stopping without it`,
  );
  // The restart holding the lock sees the disarmed watchdog and starts nothing.
  stopSocketWatchdog();
  abandonSlackApp();
}

/**
 * stopSlackApp() for a caller that already holds the lifecycle lock (the
 * config reload). The lock is not reentrant: taking it again would deadlock.
 */
export async function stopSlackAppUnderLifecycleLock(): Promise<void> {
  stopSocketWatchdog();
  await teardownSlackApp();
}

/** Stop the app but keep the watchdog armed; the watchdog restart uses this. */
async function teardownSlackApp(): Promise<void> {
  const stopping = detachSlackApp();
  if (stopping) {
    await stopping.stop();
    console.log("[Slack] Bot disconnected");
  }
}

/**
 * Drop a restart that ran out of time, without waiting: app.stop() can block
 * on the stalled client too. The retired client opens no socket, and the
 * detached stop closes any socket it already has.
 */
function abandonSlackApp(): void {
  const stalled = detachSlackApp();
  void stalled?.stop().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Slack] watchdog: stopping the abandoned app failed: ${scrubSecrets(message)}`);
  });
}

/** Clear the module state synchronously and return the app to stop. */
function detachSlackApp(): App | null {
  // Retire the client first: app.stop() cannot cancel a start that is still
  // waiting for apps.connections.open.
  socketFence?.retire();
  socketFence = null;
  lifecycleGeneration += 1;
  stopTaskWatcher();
  inboundDrain?.stop();
  inboundDrain = null;
  const detached = app;
  app = null;
  receiver = null;
  lastSocketActivityAt = null;
  setSlackConnectionState("disconnected");
  initialized = false;
  return detached;
}
