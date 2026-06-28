import { App, LogLevel } from "@slack/bolt";
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

  app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
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
    await app.start();
    console.log("[Slack] Bot connected via Socket Mode");

    // Start watching for task completions
    startTaskWatcher();
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
