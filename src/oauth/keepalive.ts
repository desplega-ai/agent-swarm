import { ensureTokenOrThrow } from "./ensure-token";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const THIRTEEN_HOURS_MS = 13 * 60 * 60 * 1000;
const SLACK_ALERTS_CHANNEL = process.env.SLACK_ALERTS_CHANNEL || "C08JCRURPBV";

const KEEPALIVE_PROVIDERS = ["linear", "jira"] as const;

let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Proactively refresh OAuth tokens on a schedule to prevent expiry.
 * If refresh fails, posts a Slack notification so someone can re-auth manually.
 *
 * Why both Linear and Jira: Atlassian rotates refresh tokens and expires them
 * after 90 days of inactivity, so a swarm that doesn't touch Jira for a long
 * stretch will silently lose the ability to refresh. Touching the token every
 * 12h keeps the refresh token alive and surfaces a dead one as an alert
 * instead of a runtime 401.
 */
async function runKeepalive(): Promise<void> {
  for (const provider of KEEPALIVE_PROVIDERS) {
    console.log(`[OAuth Keepalive] Running scheduled token refresh for ${provider}...`);
    try {
      await ensureTokenOrThrow(provider, THIRTEEN_HOURS_MS);
      console.log(`[OAuth Keepalive] ${provider} token check completed successfully`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[OAuth Keepalive] Failed to refresh ${provider} token: ${message}`);
      await notifySlack(
        `⚠️ *OAuth Keepalive Failed*\nProvider: \`${provider}\`\nError: ${message}\n\nManual re-authorization may be required.`,
      );
    }
  }
}

async function notifySlack(text: string): Promise<void> {
  try {
    const { getSlackApp } = await import("../slack/app");
    const app = getSlackApp();
    if (!app) {
      console.warn("[OAuth Keepalive] Slack not available, cannot send notification");
      return;
    }
    await app.client.chat.postMessage({
      channel: SLACK_ALERTS_CHANNEL,
      text,
    });
    console.log("[OAuth Keepalive] Slack notification sent");
  } catch (slackErr) {
    console.error(
      "[OAuth Keepalive] Failed to send Slack notification:",
      slackErr instanceof Error ? slackErr.message : slackErr,
    );
  }
}

/**
 * Start the OAuth keepalive timer. Runs immediately then every 12 hours.
 */
export function startOAuthKeepalive(): void {
  if (keepaliveInterval) {
    console.log("[OAuth Keepalive] Already running, skipping");
    return;
  }

  console.log("[OAuth Keepalive] Starting (12h interval)");

  // Run once after a short delay (let server finish startup)
  setTimeout(() => runKeepalive(), 10_000);

  keepaliveInterval = setInterval(() => {
    runKeepalive();
  }, TWELVE_HOURS_MS);
}

/**
 * Stop the OAuth keepalive timer.
 */
export function stopOAuthKeepalive(): void {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
    console.log("[OAuth Keepalive] Stopped");
  }
}
