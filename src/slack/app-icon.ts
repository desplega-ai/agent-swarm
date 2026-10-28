import { WebClient } from "@slack/web-api";
import { getSlackApp } from "./app";

export const SLACK_APP_ICON_TTL_MS = 60 * 60 * 1000;
// Per request, with no retries: the lookup ends within two of these, and an
// aborted auth.test never goes on to bots.info.
const REQUEST_TIMEOUT_MS = 2_500;

let cached: { url: string | null; at: number } | null = null;
let inFlight: Promise<string | null> | null = null;

/** A client for this lookup only: the app's token and API URL, no retries, a hard request timeout. */
export function createLookupClient(
  base: Pick<WebClient, "token" | "slackApiUrl">,
  timeoutMs = REQUEST_TIMEOUT_MS,
): WebClient {
  return new WebClient(base.token, {
    slackApiUrl: base.slackApiUrl,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: timeoutMs,
  });
}

function defaultClient(): WebClient | undefined {
  const client = getSlackApp()?.client;
  return client?.token ? createLookupClient(client) : undefined;
}

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
export async function getSlackAppIconUrl({
  getClient = defaultClient,
  now = Date.now,
}: {
  getClient?: () => WebClient | undefined;
  now?: () => number;
} = {}): Promise<string | null> {
  // Slack can be turned off at runtime, so check it before the cache.
  const client = getClient();
  if (!client) return null;
  if (cached && now() - cached.at < SLACK_APP_ICON_TTL_MS) return cached.url;
  inFlight ??= lookUp(client)
    .then((url) => {
      cached = { url, at: now() };
      return url;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return await inFlight;
}

export function resetSlackAppIconCache(): void {
  cached = null;
  inFlight = null;
}
