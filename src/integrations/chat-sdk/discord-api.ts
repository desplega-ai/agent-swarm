import { scrubSecrets } from "@/utils/secret-scrubber";
import { resolveAdapterApiUrl } from "./adapters";
import { errorMessage } from "./logger";

const DISCORD_TIMEOUT_MS = 5_000;
/** The status card polls every 5 s; one Discord call per minute is enough. */
const GUILDS_CACHE_MS = 60_000;
/** Bound on the server names the status carries. */
const MAX_GUILD_NAMES = 10;

export interface DiscordGuilds {
  count: number;
  /** Up to `MAX_GUILD_NAMES` server names, for the card. */
  names: string[];
}

let cache: { token: string; at: number; guilds: DiscordGuilds | undefined } | undefined;

/**
 * The servers the bot was invited to (`GET /users/@me/guilds`). A connected
 * Gateway with zero servers means the invite step was skipped, which the card
 * can say outright. Undefined when Discord does not answer; the error is
 * logged without the token.
 */
export async function fetchDiscordGuilds(
  token: string,
  now = Date.now(),
): Promise<DiscordGuilds | undefined> {
  if (cache && cache.token === token && now - cache.at < GUILDS_CACHE_MS) return cache.guilds;
  let guilds: DiscordGuilds | undefined;
  try {
    const response = await fetch(`${resolveAdapterApiUrl("discord")}/users/@me/guilds`, {
      headers: { authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) throw new Error("unexpected response shape");
    const names = payload
      .map((guild: unknown) =>
        guild !== null &&
        typeof guild === "object" &&
        typeof (guild as { name?: unknown }).name === "string"
          ? (guild as { name: string }).name
          : undefined,
      )
      .filter((name): name is string => name !== undefined);
    guilds = { count: payload.length, names: names.slice(0, MAX_GUILD_NAMES) };
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[chat-sdk] discord: could not list the bot's servers: ${errorMessage(error).replaceAll(token, "[REDACTED]")}`,
      ),
    );
  }
  cache = { token, at: now, guilds };
  return guilds;
}

/** Test seam. */
export function resetDiscordGuildsCache(): void {
  cache = undefined;
}
