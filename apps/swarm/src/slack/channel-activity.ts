import { getSlackApp } from "./app";

export interface ChannelMessage {
  channelId: string;
  channelName?: string;
  ts: string;
  user: string;
  text: string;
}

// ─── Caches ─────────────────────────────────────────────────────────────────

let cachedBotUserId: string | null = null;

interface ChannelCache {
  channels: Array<{ id: string; name?: string }>;
  fetchedAt: number;
}
let channelCache: ChannelCache | null = null;
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch recent non-bot messages from channels the bot is in,
 * filtering to only messages newer than the provided cursors.
 *
 * For channels with no cursor (first run), returns the latest message ts
 * as a seed cursor without triggering — prevents cold-start flood.
 *
 * Returns messages sorted oldest-first, plus seed cursors for new channels.
 */
export async function fetchChannelActivity(
  cursors: Map<string, string>,
  allowedChannelIds?: string[],
  limit = 10,
): Promise<{ messages: ChannelMessage[]; seedCursors: Map<string, string> }> {
  const app = getSlackApp();
  if (!app) return { messages: [], seedCursors: new Map() };

  const client = app.client;

  // Get channels the bot is a member of (cached, with pagination)
  let channels = getCachedChannels();
  if (!channels) {
    channels = await fetchAllBotChannels(client);
    setCachedChannels(channels);
  }

  // Filter by allowlist if configured
  if (allowedChannelIds && allowedChannelIds.length > 0) {
    const allowed = new Set(allowedChannelIds);
    channels = channels.filter((ch) => allowed.has(ch.id));
  }

  if (channels.length === 0) return { messages: [], seedCursors: new Map() };

  const messages: ChannelMessage[] = [];
  const seedCursors = new Map<string, string>();

  // Cache bot user ID (never changes during runtime)
  if (!cachedBotUserId) {
    const authResult = await client.auth.test();
    cachedBotUserId = authResult.user_id as string;
  }
  const botUserId = cachedBotUserId;

  for (const channel of channels) {
    const channelId = channel.id;
    const cursor = cursors.get(channelId);

    try {
      // Cold-start: no cursor for this channel — seed it without triggering
      if (!cursor) {
        const seedResult = await client.conversations.history({
          channel: channelId,
          limit: 1,
        });
        const latestMsg = seedResult.messages?.[0];
        if (latestMsg?.ts) {
          seedCursors.set(channelId, latestMsg.ts);
        }
        continue; // Don't trigger on first run
      }

      const historyResult = await client.conversations.history({
        channel: channelId,
        oldest: cursor,
        limit,
      });

      for (const msg of historyResult.messages || []) {
        // Skip the cursor message itself (oldest is inclusive)
        if (msg.ts === cursor) continue;
        // Skip bot messages (bot_id present, or subtype bot_message)
        if (msg.bot_id || msg.subtype === "bot_message") continue;
        // Skip our own bot's messages
        if (msg.user === botUserId) continue;
        // Skip messages without text or user
        if (!msg.text?.trim() || !msg.user) continue;
        // Skip thread replies (only top-level channel messages)
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;

        messages.push({
          channelId,
          channelName: channel.name,
          ts: msg.ts!,
          user: msg.user,
          text: msg.text,
        });
      }
    } catch (err) {
      // Log but don't fail — channel might have been archived or bot removed
      console.warn(`[channel-activity] Failed to fetch history for ${channelId}: ${err}`);
    }
  }

  // Sort by timestamp ascending (oldest first)
  messages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));

  return { messages, seedCursors };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function getCachedChannels(): Array<{ id: string; name?: string }> | null {
  if (!channelCache) return null;
  if (Date.now() - channelCache.fetchedAt > CHANNEL_CACHE_TTL_MS) {
    channelCache = null;
    return null;
  }
  return channelCache.channels;
}

function setCachedChannels(channels: Array<{ id: string; name?: string }>): void {
  channelCache = { channels, fetchedAt: Date.now() };
}

/** Fetch all channels the bot is a member of, handling pagination */
async function fetchAllBotChannels(
  client: ReturnType<typeof getSlackApp> extends infer A
    ? A extends { client: infer C }
      ? C
      : never
    : never,
): Promise<Array<{ id: string; name?: string }>> {
  const channels: Array<{ id: string; name?: string }> = [];
  let nextCursor: string | undefined;

  do {
    const result = await (
      client as {
        conversations: {
          list: (args: Record<string, unknown>) => Promise<{
            channels?: Array<{ id?: string; name?: string; is_member?: boolean }>;
            response_metadata?: { next_cursor?: string };
          }>;
        };
      }
    ).conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor: nextCursor || undefined,
    });

    for (const ch of result.channels || []) {
      if (ch.id && ch.is_member) {
        channels.push({ id: ch.id, name: ch.name });
      }
    }

    nextCursor = result.response_metadata?.next_cursor || undefined;
  } while (nextCursor);

  return channels;
}
