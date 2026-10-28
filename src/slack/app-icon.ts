import type { WebClient } from "@slack/web-api";
import { getSlackApp } from "./app";

const TTL_MS = 60 * 60 * 1000;
// The WebClient retries auth.test for a long time; the dashboard preview must not wait for that.
const TIMEOUT_MS = 5_000;

let cached: { url: string | null; at: number } | null = null;
let inFlight: Promise<string | null> | null = null;

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
export async function getSlackAppIconUrl(
  getClient: () => WebClient | undefined = () => getSlackApp()?.client,
): Promise<string | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.url;
  const client = getClient();
  if (!client) return null;
  if (!inFlight) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    });
    inFlight = Promise.race([lookUp(client), timeout])
      .then((url) => {
        cached = { url, at: Date.now() };
        return url;
      })
      .catch(() => null)
      .finally(() => {
        clearTimeout(timer);
        inFlight = null;
      });
  }
  return await inFlight;
}

export function resetSlackAppIconCache(): void {
  cached = null;
  inFlight = null;
}
