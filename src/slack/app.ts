import { App, LogLevel } from "@slack/bolt";
import { emitBuiltInIntegrationConnectedOnce, ensureSlackRenderV2Activation } from "../be/db";
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
  initialized = true;

  // Check if Slack is explicitly disabled
  const slackDisable = process.env.SLACK_DISABLE;
  if (slackDisable === "true" || slackDisable === "1") {
    console.log("[Slack] Disabled via SLACK_DISABLE");
    return null;
  }

  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    console.log("[Slack] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN, Slack integration disabled");
    return null;
  }

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

  // Register handlers
  const { registerMessageHandler } = await import("./handlers");
  const { registerCommandHandler } = await import("./commands");
  const { registerActionHandlers } = await import("./actions");

  registerMessageHandler(app);
  registerCommandHandler(app);
  registerActionHandlers(app);

  // Register assistant thread handler (safe even if "Agents & AI Apps" isn't enabled)
  const { createAssistant } = await import("./assistant");
  app.assistant(createAssistant());

  return app;
}

export async function startSlackApp(): Promise<void> {
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
  }
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
