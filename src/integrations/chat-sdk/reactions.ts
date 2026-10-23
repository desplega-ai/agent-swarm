import { getKv } from "@/be/db";
import type { ReactionEvent } from "@/integrations/reaction-events";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { errorMessage } from "./logger";
import { chatChannelKey } from "./router";
import { getChatInstance } from "./runtime";
import { assertTrustedChatTarget } from "./teams-origin";

/**
 * Telegram reactions per lifecycle event. A bot may set only the emoji in the
 * Bot API `ReactionTypeEmoji` list (https://core.telegram.org/bots/api#reactiontypeemoji),
 * which has no ✅ or ❌. `✍` is U+270D with no variation selector, as listed.
 * A bot sets one reaction per message, so each call replaces the previous one.
 */
export const TELEGRAM_REACTIONS: Record<ReactionEvent, string> = {
  accepted: "👀",
  buffered: "👀",
  now: "⚡",
  steered: "✍",
  completed: "👍",
  failed: "👎",
};

/** Adapters that show the task lifecycle as a reaction on the user's message. */
const CHAT_REACTIONS: Readonly<Record<string, Record<ReactionEvent, string>>> = {
  telegram: TELEGRAM_REACTIONS,
};

/** True when `adapter` shows the lifecycle as reactions instead of text acknowledgements. */
export function chatAdapterReacts(adapter: string): boolean {
  return adapter in CHAT_REACTIONS;
}

/**
 * Set the reaction for `event` on one message. Best effort: an adapter without
 * a reaction map is a no-op, and a platform error (Telegram answers
 * `400 REACTION_INVALID` for an emoji a group admin disallowed) is logged and
 * never thrown, so it cannot block delivery or fail the task.
 */
export async function setChatMessageReaction(
  adapter: string,
  threadId: string,
  messageId: string,
  event: ReactionEvent,
): Promise<void> {
  const emoji = CHAT_REACTIONS[adapter]?.[event];
  if (!emoji) return;
  try {
    const target = getChatInstance(adapter)?.getAdapter(adapter);
    if (!target) return;
    assertTrustedChatTarget(threadId);
    await target.addReaction(threadId, messageId, emoji);
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[chat-sdk] Could not set the ${event} reaction on ${messageId} in ${threadId}: ${errorMessage(error)}`,
      ),
    );
  }
}

/** Remove the bot's reaction from each message. Best effort, like {@link setChatMessageReaction}. */
export async function clearChatMessageReactions(
  adapter: string,
  threadId: string,
  messageIds: readonly string[],
): Promise<void> {
  if (!chatAdapterReacts(adapter) || messageIds.length === 0) return;
  const target = getChatInstance(adapter)?.getAdapter(adapter);
  if (!target) return;
  for (const messageId of messageIds) {
    try {
      // Telegram clears the bot's whole reaction whatever emoji is named.
      await target.removeReaction(threadId, messageId, TELEGRAM_REACTIONS.accepted);
    } catch (error) {
      console.warn(
        scrubSecrets(
          `[chat-sdk] Could not clear the reaction on ${messageId} in ${threadId}: ${errorMessage(error)}`,
        ),
      );
    }
  }
}

/** KV namespace of per-channel Chat SDK settings, keyed like the channel mappings. */
export const CHAT_CHANNEL_SETTINGS_NAMESPACE = "integrations:chat:channel-settings";

export interface ChatChannelSettings {
  /** Also post the text steering acknowledgement on an adapter that reacts. */
  textAcks?: boolean;
}

/**
 * Whether a steering message gets a text acknowledgement. Adapters without
 * reactions always get one; a reacting adapter only when its channel opts in.
 */
export async function wantsChatTextAck(adapter: string, channelId: string): Promise<boolean> {
  if (!chatAdapterReacts(adapter)) return true;
  try {
    const row = await getKv(CHAT_CHANNEL_SETTINGS_NAMESPACE, chatChannelKey(adapter, channelId));
    const settings = row?.value as ChatChannelSettings | null | undefined;
    return typeof settings === "object" && settings !== null && settings.textAcks === true;
  } catch (error) {
    console.warn(`[chat-sdk] Could not read the channel settings: ${errorMessage(error)}`);
    return false;
  }
}
