import { getSlackApp } from "./app";

export interface ChannelMessage {
  channelId: string;
  channelName?: string;
  ts: string;
  user: string;
  text: string;
}

/**
 * Fetch recent non-bot messages from channels the bot is in,
 * filtering to only messages newer than the provided cursors.
 *
 * Returns messages grouped by channel, sorted oldest-first.
 */
export async function fetchChannelActivity(
  cursors: Map<string, string>,
  limit = 10,
): Promise<ChannelMessage[]> {
  const app = getSlackApp();
  if (!app) return [];

  const client = app.client;

  // Get channels the bot is a member of (public + private)
  const channelsResult = await client.conversations.list({
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200,
  });

  const channels = (channelsResult.channels || []).filter((ch) => ch.id && ch.is_member);

  if (channels.length === 0) return [];

  const messages: ChannelMessage[] = [];

  // Get bot's own user ID to filter out our messages
  const authResult = await client.auth.test();
  const botUserId = authResult.user_id;

  for (const channel of channels) {
    const channelId = channel.id!;
    const cursor = cursors.get(channelId);

    try {
      const historyResult = await client.conversations.history({
        channel: channelId,
        oldest: cursor || undefined,
        limit,
      });

      for (const msg of historyResult.messages || []) {
        // Skip the cursor message itself (oldest is inclusive)
        if (cursor && msg.ts === cursor) continue;
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
          channelName: channel.name ?? undefined,
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

  return messages;
}
