import { ensureTokenOrThrow } from "./ensure-token";

// Keep refresh tokens warm without constantly rotating strict-rotation
// providers. Reactive callers still refresh access tokens before API use.
const KEEPALIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const KEEPALIVE_BUFFER_MS = 10 * 60 * 1000;
const STARTUP_KEEPALIVE_DELAY_MS = 10_000;

const KEEPALIVE_PROVIDERS = ["linear", "jira"] as const;

let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
let startupKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null;
let inflightKeepalive: Promise<void> | null = null;

function scheduleKeepaliveRun(trigger: "startup" | "interval" | "manual"): Promise<void> {
  if (inflightKeepalive) {
    console.log(`[OAuth Keepalive] ${trigger} tick skipped; previous run still in flight`);
    return inflightKeepalive;
  }

  inflightKeepalive = runKeepalive(trigger).finally(() => {
    inflightKeepalive = null;
  });
  return inflightKeepalive;
}

/**
 * Proactively refresh OAuth tokens on a schedule.
 *
 * Two purposes, both served by the same tick:
 *
 *  1. Refresh-token liveness. Atlassian rotates refresh tokens and expires
 *     them after ~90 days of inactivity, so silent gaps in usage would kill
 *     the integration. The 12h cadence keeps the refresh token active without
 *     rotating it dozens of times per day.
 *  2. Loud failure on boot and during scheduled checks. A dead token surfaces
 *     as structured logs plus a Slack alert instead of silently retrying.
 *
 * Access-token freshness is handled reactively by ensureToken callers before
 * Jira/Linear API use.
 */
async function runKeepalive(trigger: "startup" | "interval" | "manual" = "manual"): Promise<void> {
  console.log(`[OAuth Keepalive] Running ${trigger} token refresh check`);
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
  const channel = process.env.SLACK_ALERTS_CHANNEL;
  if (!channel) {
    console.warn("[OAuth Keepalive] SLACK_ALERTS_CHANNEL not set; skipping alert");
    return;
  }

  try {
    const { getSlackApp } = await import("../slack/app");
    const app = getSlackApp();
    if (!app) {
      console.warn("[OAuth Keepalive] Slack not available, cannot send notification");
      return;
    }
    await app.client.chat.postMessage({
      channel,
      text,
    });
    console.log(`[OAuth Keepalive] Slack notification sent to ${channel}`);
  } catch (slackErr) {
    const code =
      typeof slackErr === "object" && slackErr !== null && "code" in slackErr
        ? ` code=${String(slackErr.code)}`
        : "";
    const data =
      typeof slackErr === "object" && slackErr !== null && "data" in slackErr
        ? ` data=${JSON.stringify(slackErr.data)}`
        : "";
    console.error(
      `[OAuth Keepalive] Failed to send Slack notification to ${channel}${code}${data}:`,
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

  // Run once after a short delay (let server finish startup).
  startupKeepaliveTimeout = setTimeout(() => {
    startupKeepaliveTimeout = null;
    scheduleKeepaliveRun("startup");
  }, STARTUP_KEEPALIVE_DELAY_MS);

  keepaliveInterval = setInterval(() => {
    scheduleKeepaliveRun("interval");
  }, KEEPALIVE_INTERVAL_MS);
}

/**
 * Stop the OAuth keepalive timer and wait for any in-flight refresh to persist.
 */
export async function stopOAuthKeepalive(): Promise<void> {
  if (startupKeepaliveTimeout) {
    clearTimeout(startupKeepaliveTimeout);
    startupKeepaliveTimeout = null;
  }

  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
    console.log("[OAuth Keepalive] Stopped");
  }

  if (inflightKeepalive) {
    console.log("[OAuth Keepalive] Waiting for in-flight token refresh before shutdown");
    await inflightKeepalive;
  }
}

// ─── Test helpers (exported for unit tests only) ─────────────────────────────

export const _test = {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_BUFFER_MS,
  STARTUP_KEEPALIVE_DELAY_MS,
  notifySlack,
  runKeepalive: scheduleKeepaliveRun,
  getInflightKeepalive: () => inflightKeepalive,
};
