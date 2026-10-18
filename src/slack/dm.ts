import type { WebClient } from "@slack/web-api";

/** Slack user ids start with U (or W on Enterprise Grid); conversation ids start with C, G or D. */
export function isSlackUserId(id: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(id);
}

/**
 * Resolves a user id to the bot's own DM with that user; returns any other id unchanged.
 *
 * chat.postMessage accepts a user id as `channel`, but Slack documents that the
 * message then lands in the user's DM with Slackbot (USLACK), which the bot is
 * not a member of. conversations.replies and chat.postMessage on the returned
 * D id fail with channel_not_found, and human replies never reach the bot as
 * message.im events. conversations.open returns the bot's own IM, which it can
 * read, write, and receives events for.
 */
export async function resolveSlackConversationId(
  client: WebClient,
  channelId: string,
): Promise<string> {
  if (!isSlackUserId(channelId)) return channelId;
  const result = await client.conversations.open({ users: channelId });
  const dmId = result.channel?.id;
  if (!dmId) {
    throw new Error(`conversations.open returned no DM channel for user ${channelId}`);
  }
  return dmId;
}
