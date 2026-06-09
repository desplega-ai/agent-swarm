import type { WebClient } from "@slack/web-api";

// @slack/web-api platform errors set message to "An API error occurred: <code>"
// and store the raw Slack API code at error.data.error.
function slackCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const d = (error as { data?: { error?: unknown } }).data;
  return typeof d?.error === "string" ? d.error : undefined;
}

/**
 * Wraps a Slack API call with automatic channel join for public channels.
 *
 * On not_in_channel: calls conversations.join and retries the original call once.
 * On private channel (method_not_supported_for_channel_type): throws a descriptive
 * error telling the caller the bot must be /invite-d — it cannot self-join private channels.
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
