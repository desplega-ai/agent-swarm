import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { emitBuiltInIntegrationConnectedOnce, ensureSlackRenderV2Activation } from "../be/db";
import { getNodeEnv } from "../utils/node-env";
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
import { getSlackSocketModeBlockReason, SLACK_DEV_SOCKET_MODE_OPT_IN } from "./socket-mode-guard";
import { startTaskWatcher, stopTaskWatcher } from "./watcher";

let app: App | null = null;
let receiver: SocketModeReceiver | null = null;
let initialized = false;
let inboundDrain: ReturnType<typeof installSocketAckRecovery> | null = null;
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
}

export const SLACK_SOCKET_WATCHDOG_DEFAULTS: SlackSocketWatchdogOptions = {
  tickMs: 5_000,
  downAfterMs: 60_000,
  staleActivityMs: 10 * 60_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 5 * 60_000,
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
 * `tick()`. The two log lines feed a Datadog log-based metric, so keep their
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
      console.error("[Slack] watchdog: restart failed:", error);
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
 * Rebuild the Slack app under the lifecycle lock. No timeout: a start that
 * hangs is the web client retrying apps.connections.open, which is progress,
 * and abandoning it would leave a second live socket behind.
 */
async function restartSlackAppForWatchdog(): Promise<void> {
  await runSlackLifecycleExclusive(async () => {
    // A config reload that won the lock may have just brought the socket back.
    if (getSlackConnectionState() === "connected" && isLiveSocketActive()) return;
    await teardownSlackApp();
    await startSlackApp();
  });
}

function startSocketWatchdog(): void {
  if (watchdogTimer) return;
  const watchdog = createSlackSocketWatchdog(
    {
      now: Date.now,
      getState: getSlackConnectionState,
      getLastActivityAt: () => lastSocketActivityAt,
      isSocketActive: isLiveSocketActive,
      isLifecycleBusy: isSlackLifecycleBusy,
      restart: restartSlackAppForWatchdog,
      log: (line) => console.log(line),
    },
    watchdogOptions,
  );
  watchdogTimer = setInterval(() => {
    if (getSlackConfiguration().mode !== "socket") {
      stopSocketWatchdog();
      return;
    }
    void watchdog.tick();
  }, watchdogOptions.tickMs);
  // Never keep the process (or a test run) alive for the watchdog alone.
  watchdogTimer.unref?.();
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
  if (!app) {
    await initSlackApp();
  }

  if (app) {
    // Arm before app.start(): a start that throws is retried by the watchdog.
    startSocketWatchdog();
    // Establish the durable cutoff before Socket Mode can deliver new asks.
    const { isSlackRenderV2Enabled } = await import("./render-v2");
    if (isSlackRenderV2Enabled()) await ensureSlackRenderV2Activation();
    // Receipts stored before the last restart: interrupted ones turn uncertain,
    // pending ones are processed once the app can dispatch them.
    await recoverSlackInboundAfterRestart();
    await app.start();
    console.log("[Slack] Bot connected via Socket Mode");
    void inboundDrain?.wake();
    await emitBuiltInIntegrationConnectedOnce("slack");

    // Start watching for task completions
    await startTaskWatcher();
    return true;
  }

  return false;
}

export async function stopSlackApp(): Promise<void> {
  stopSocketWatchdog();
  await teardownSlackApp();
}

/** Stop the app but keep the watchdog armed; the watchdog restart uses this. */
async function teardownSlackApp(): Promise<void> {
  stopTaskWatcher();
  inboundDrain?.stop();
  inboundDrain = null;

  if (app) {
    await app.stop();
    app = null;
    console.log("[Slack] Bot disconnected");
  }
  receiver = null;
  lastSocketActivityAt = null;
  setSlackConnectionState("disconnected");
  initialized = false;
}
