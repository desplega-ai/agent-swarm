import { WebClient } from "@slack/web-api";
import { getSlackApp } from "./app";

const TTL_MS = 60 * 60 * 1000;
// Per request, with no retries: the lookup ends within two of these, and an
// aborted auth.test never goes on to bots.info.
const REQUEST_TIMEOUT_MS = 2_500;

// Keyed by token and API URL, so a reconfigured Slack app is looked up again.
let cached: { key: string; url: string | null; at: number } | null = null;
let inFlight: { key: string; promise: Promise<string | null> } | null = null;

async function lookUp(client: WebClient): Promise<string | null> {
  const auth = await client.auth.test();
  if (!auth.bot_id) return null;
  const info = await client.bots.info({ bot: auth.bot_id });
  const icons = info.bot?.icons;
  return icons?.image_72 ?? icons?.image_48 ?? icons?.image_36 ?? null;
}

/**
 * The avatar Slack shows for this app's posts when no icon is overridden
 * (`bots.info` for the bot behind the token). Null when Slack is off or the
 * lookup fails. Cached for an hour; failures are not cached.
 */
export async function getSlackAppIconUrl(): Promise<string | null> {
  // Slack can be turned off at runtime, so check it before the cache.
  const app = getSlackApp()?.client;
  if (!app?.token) return null;
  const key = `${app.slackApiUrl} ${app.token}`;
  if (cached?.key === key && Date.now() - cached.at < TTL_MS) return cached.url;
  if (inFlight?.key === key) return await inFlight.promise;
  const client = new WebClient(app.token, {
    slackApiUrl: app.slackApiUrl,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const promise: Promise<string | null> = lookUp(client)
    .then((url) => {
      cached = { key, url, at: Date.now() };
      return url;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return await promise;
}
