import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { emitBuiltInIntegrationConnectedOnce, ensureSlackRenderV2Activation } from "../be/db";
import { getNodeEnv } from "../utils/node-env";
import { getSlackConfiguration } from "./config";
import { type SlackConnectionState, setSlackConnectionState } from "./connection-state";
import { installSlackEgressScrub } from "./egress-scrub";
import { installSlackExternalChannelGuard } from "./external-channel-egress";
import { recoverSlackInboundAfterRestart, slackInboundOutcomeMiddleware } from "./inbound-dispatch";
import { installSocketAckRecovery } from "./socket-ack";
import { getSlackSocketModeBlockReason, SLACK_DEV_SOCKET_MODE_OPT_IN } from "./socket-mode-guard";
import { startTaskWatcher, stopTaskWatcher } from "./watcher";
import {
  getSlackWorkspaceIdentity,
  identityFromAuthTest,
  installSocketWorkspaceGate,
  isSlackEnterpriseInstall,
  setSlackWorkspaceIdentitySource,
} from "./workspace-guard";

let app: App | null = null;
let receiver: SocketModeReceiver | null = null;
let initialized = false;
let inboundDrain: ReturnType<typeof installSocketAckRecovery> | null = null;

/** Backoff between start attempts while this swarm's workspace is unknown. */
const DEFAULT_START_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
let startRetryDelaysMs = DEFAULT_START_RETRY_DELAYS_MS;
let startRetryTimer: ReturnType<typeof setTimeout> | null = null;
let startRetryAttempt = 0;
/** Bumped by stopSlackApp(): a retry scheduled before a stop never runs. */
let lifecycle = 0;
/** Bolt's deferred init (its own auth.test) succeeded for the current app. */
let boltInitialized = false;

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
      if (receiver === owner) setSlackConnectionState(state);
    });
  }
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
    // Bolt's auth.test runs in startSlackApp(), where a failure is retried
    // instead of being cached as a rejected promise for the app's lifetime.
    deferInitialization: true,
    ...(clientOptions ? { clientOptions } : {}),
  });

  // Events whose Socket Mode ack failed are stored as receipts; the drain hands
  // them back to Bolt, so a crash or a failing listener leaves recoverable work.
  inboundDrain = installSocketAckRecovery(receiver.client, app);

  // This swarm's installation. Installed last, the gate runs before the ack
  // recovery wrapper and Bolt: a delivery for any other installation sharing
  // this Slack app is never acked, stored or dispatched, so Slack redelivers it.
  const authClient = app.client;
  const enterpriseInstall = isSlackEnterpriseInstall();
  setSlackWorkspaceIdentitySource(async () =>
    identityFromAuthTest(await authClient.auth.test(), enterpriseInstall),
  );
  installSocketWorkspaceGate(receiver.client);

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
    clearStartRetry();
    // Fail closed: without this swarm's identity the gate admits nothing, so
    // the socket stays closed and other swarms sharing the app keep receiving.
    if (!(await verifySlackIdentity(app))) {
      const delay = scheduleStartRetry();
      setSlackConnectionState("disconnected");
      console.error(
        `[Slack] Socket Mode not started: this swarm's workspace is unknown. Retrying in ${Math.round(delay / 1000)}s`,
      );
      return false;
    }
    startRetryAttempt = 0;
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

/** Resolve this swarm's identity, then Bolt's own authorization. False on any failure. */
async function verifySlackIdentity(current: App): Promise<boolean> {
  if (!(await getSlackWorkspaceIdentity())) return false;
  if (boltInitialized) return true;
  try {
    await current.init();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Slack] Bolt initialization failed: ${message}`);
    return false;
  }
  boltInitialized = true;
  return true;
}

function clearStartRetry(): void {
  if (startRetryTimer) clearTimeout(startRetryTimer);
  startRetryTimer = null;
}

/** Retry the start after a backoff. Returns the delay. */
function scheduleStartRetry(): number {
  const delay = startRetryDelaysMs[Math.min(startRetryAttempt, startRetryDelaysMs.length - 1)]!;
  startRetryAttempt += 1;
  const generation = lifecycle;
  startRetryTimer = setTimeout(() => {
    startRetryTimer = null;
    if (generation !== lifecycle) return;
    void startSlackApp().catch((error) => console.error("[Slack] Start retry failed:", error));
  }, delay);
  startRetryTimer.unref?.();
  return delay;
}

export async function stopSlackApp(): Promise<void> {
  lifecycle += 1;
  clearStartRetry();
  startRetryAttempt = 0;
  boltInitialized = false;
  stopTaskWatcher();
  inboundDrain?.stop();
  inboundDrain = null;

  if (app) {
    await app.stop();
    app = null;
    console.log("[Slack] Bot disconnected");
  }
  receiver = null;
  setSlackWorkspaceIdentitySource(null);
  setSlackConnectionState("disconnected");
  initialized = false;
}

/** Test-only: shorten the start retry backoff; null restores the default. */
export function setSlackStartRetryDelaysForTests(delaysMs: number[] | null): void {
  startRetryDelaysMs = delaysMs ?? DEFAULT_START_RETRY_DELAYS_MS;
}
