import type { WebClient } from "@slack/web-api";

const logger = console;

// @slack/web-api platform errors set message to "An API error occurred: <code>"
// and store the raw Slack API code at error.data.error.
function slackCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const d = (error as { data?: { error?: unknown } }).data;
  return typeof d?.error === "string" ? d.error : undefined;
}

/**
 * Returns true if the channel has any external (non-host-org) members.
 * Uses Slack's documented flags: is_ext_shared (accepted Connect) and
 * is_pending_ext_shared (invite sent, not yet accepted). These two booleans
 * are the authoritative org-boundary signal per Slack's API docs.
 */
async function isKnownExternalChannel(client: WebClient, channelId: string): Promise<boolean> {
  try {
    const resp = await client.conversations.info({ channel: channelId });
    const ch = (resp.channel ?? {}) as {
      is_ext_shared?: boolean;
      is_pending_ext_shared?: boolean;
    };
    return ch.is_ext_shared === true || ch.is_pending_ext_shared === true;
  } catch (error) {
    logger.warn(
      `[Slack] conversations.info failed for ${channelId}; attempting join fallback:`,
      error,
    );
    return false;
  }
}

/**
 * Wraps a Slack API call with automatic channel join for public channels.
 *
 * On not_in_channel: checks conversations.info first — if is_ext_shared or
 * is_pending_ext_shared is true the channel has external members; throws a
 * human-invite error instead of self-joining. Internal channels (including
 * Enterprise Grid org-shared channels) proceed normally.
 * On private channel (method_not_supported_for_channel_type): throws a
 * descriptive error telling the caller to /invite the bot.
 */
export async function withAutoJoin<T>(
  client: WebClient,
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (slackCode(error) !== "not_in_channel") throw error;

    // Only block when Slack positively identifies an external channel.
    if (await isKnownExternalChannel(client, channelId)) {
      throw new Error(
        `Cannot auto-join external channel ${channelId} — invite the bot with /invite @<bot-name> first.`,
      );
    }

    try {
      await client.conversations.join({ channel: channelId });
    } catch (joinError) {
      if (slackCode(joinError) === "method_not_supported_for_channel_type") {
        throw new Error(
          `Cannot access private channel ${channelId} — invite the bot with /invite @<bot-name> first.`,
        );
      }
      throw joinError;
    }

    return await fn();
  }
}
