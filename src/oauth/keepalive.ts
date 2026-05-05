import { ensureTokenOrThrow } from "./ensure-token";

// Tick every 50 minutes with a 65-minute "expiring soon" buffer.
//
// Atlassian (and Linear) issue 1h access tokens. With this cadence the DB row
// is always rotated before its current access token expires, so anything that
// reads oauth_tokens.accessToken directly without going through jiraFetch /
// linear-outbound (e.g. agents using the read-only db-query MCP) sees a
// not-yet-expired token. The 65-min buffer is wider than the access-token
// lifetime, so isTokenExpiringSoon always returns true and every tick rotates.
//
// Touching the row this often also serves the original "keep the refresh
// token alive" goal — Atlassian expires inactive refresh tokens after 90 days,
// and Linear's behavior is similar; refreshing every 50 min trivially keeps
// both providers active.
const KEEPALIVE_INTERVAL_MS = 50 * 60 * 1000;
const KEEPALIVE_BUFFER_MS = 65 * 60 * 1000;
const SLACK_ALERTS_CHANNEL = process.env.SLACK_ALERTS_CHANNEL || "C08JCRURPBV";

const KEEPALIVE_PROVIDERS = ["linear", "jira"] as const;

let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Proactively refresh OAuth tokens on a schedule.
 *
 * Two purposes, both served by the same tick:
 *
 *  1. Access-token freshness in the DB. Anything that reads
 *     `oauth_tokens.accessToken` directly (db-query MCP, future MCP servers,
 *     `tracker-status`) needs a not-yet-expired value. The 50-min cadence
 *     keeps the row ahead of the 1h access-token lifetime.
 *  2. Refresh-token liveness. Atlassian rotates refresh tokens and expires
 *     them after ~90 days of inactivity, so silent gaps in usage would kill
 *     the integration. Refreshing on every tick keeps the refresh token
 *     active and surfaces a dead one as a Slack alert instead of a runtime
 *     401 in the middle of an agent task.
 */
async function runKeepalive(): Promise<void> {
  for (const provider of KEEPALIVE_PROVIDERS) {
    console.log(`[OAuth Keepalive] Running scheduled token refresh for ${provider}...`);
    try {
      await ensureTokenOrThrow(provider, KEEPALIVE_BUFFER_MS);
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
 * Start the OAuth keepalive timer. Runs once shortly after startup, then on
 * KEEPALIVE_INTERVAL_MS thereafter.
 */
export function startOAuthKeepalive(): void {
  if (keepaliveInterval) {
    console.log("[OAuth Keepalive] Already running, skipping");
    return;
  }

  console.log(
    `[OAuth Keepalive] Starting (interval ${Math.round(KEEPALIVE_INTERVAL_MS / 60_000)}min, buffer ${Math.round(KEEPALIVE_BUFFER_MS / 60_000)}min)`,
  );

  // Run once after a short delay (let server finish startup)
  setTimeout(() => runKeepalive(), 10_000);

  keepaliveInterval = setInterval(() => {
    runKeepalive();
  }, KEEPALIVE_INTERVAL_MS);
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
