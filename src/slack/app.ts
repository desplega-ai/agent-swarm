import { App, LogLevel } from "@slack/bolt";
import { emitBuiltInIntegrationConnectedOnce, ensureSlackRenderV2Activation } from "../be/db";
import { getSlackConfiguration } from "./config";
import { slackInboundOutcomeMiddleware } from "./inbound-dispatch";
import { getSlackSocketModeBlockReason, SLACK_DEV_SOCKET_MODE_OPT_IN } from "./socket-mode-guard";
import { startTaskWatcher, stopTaskWatcher } from "./watcher";

let app: App | null = null;
let initialized = false;

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

  // SLACK_API_URL points Bolt (Web API and apps.connections.open) at a mock Slack server for e2e tests.
  const slackApiUrl = process.env.SLACK_API_URL;
  app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
    ...(slackApiUrl ? { clientOptions: { slackApiUrl } } : {}),
  });

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

  return app;
}

export async function startSlackApp(): Promise<boolean> {
  if (!app) {
    await initSlackApp();
  }

  if (app) {
    // Establish the durable cutoff before Socket Mode can deliver new asks.
    const { isSlackRenderV2Enabled } = await import("./render-v2");
    if (isSlackRenderV2Enabled()) await ensureSlackRenderV2Activation();
    await app.start();
    console.log("[Slack] Bot connected via Socket Mode");
    await emitBuiltInIntegrationConnectedOnce("slack");

    // Start watching for task completions
    await startTaskWatcher();
    return true;
  }

  return false;
}

export async function stopSlackApp(): Promise<void> {
  stopTaskWatcher();

  if (app) {
    await app.stop();
    app = null;
    console.log("[Slack] Bot disconnected");
  }
  initialized = false;
}
