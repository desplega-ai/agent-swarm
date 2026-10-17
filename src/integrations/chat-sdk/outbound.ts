import { scrubSecrets } from "@/utils/secret-scrubber";
import { workflowEventBus } from "@/workflows/event-bus";
import { chatMessageLimit, splitChatMessage } from "./limits";
import { getChatInstance } from "./runtime";
import { assertTrustedChatTarget } from "./teams-origin";

/** The adapter is not configured, failed to start, or is shutting down. */
export class ChatAdapterUnavailableError extends Error {
  constructor(adapter: string) {
    super(`Chat SDK adapter '${adapter}' is not running`);
    this.name = "ChatAdapterUnavailableError";
  }
}

export interface ChatSentEvent {
  adapter: string;
  channelId: string;
  threadId: string;
  text: string;
  taskId?: string;
  messageId?: string;
}

/**
 * Publish an outbound message on the bus. The post-bridge turns it into the
 * `post.chat.message` extension event with `direction: "outbound"`.
 */
export function emitChatMessageSent(event: ChatSentEvent): void {
  workflowEventBus.emit("chat.message.sent", { ...event, text: scrubSecrets(event.text) });
}

/** The adapter name is the first segment of an SDK thread or channel id. */
export function adapterOfChatId(id: string): string {
  const index = id.indexOf(":");
  return index === -1 ? id : id.slice(0, index);
}

export interface ChatPostResult {
  adapter: string;
  threadId: string;
  channelId: string;
  /** One id per chunk, in send order. */
  messageIds: string[];
}

type SentChunk = { id: string; threadId?: string };

interface PostTarget {
  post(message: { markdown: string }): Promise<SentChunk>;
}

/** `replyFirst` sends the first chunk as a native reply; later chunks are plain posts. */
async function postChunks(
  adapter: string,
  target: PostTarget,
  parts: readonly string[],
  replyFirst?: (message: { markdown: string }) => Promise<SentChunk>,
): Promise<{ messageIds: string[]; threadId?: string }> {
  const messageIds: string[] = [];
  let threadId: string | undefined;
  const limit = chatMessageLimit(adapter);
  for (const chunk of parts.flatMap((part) => splitChatMessage(part, limit))) {
    const message = { markdown: chunk };
    const sent =
      replyFirst && messageIds.length === 0
        ? await replyFirst(message)
        : await target.post(message);
    messageIds.push(sent.id);
    threadId ??= sent.threadId;
  }
  return { messageIds, threadId };
}

/**
 * Post markdown to a Chat SDK thread or channel. Scrubs the text, splits it by
 * the adapter limit, and emits one `chat.message.sent` for the whole message
 * once every chunk was accepted. Throws `ChatAdapterUnavailableError` when the
 * adapter is not running, `UntrustedTeamsServiceUrlError` before any send
 * when a Teams id points at a host that is not Bot Framework, and the adapter
 * error when a send fails.
 *
 * Delivery is at-least-once: a chunk failure re-posts earlier chunks on retry,
 * and a crash between the send and `markChatRelayDelivered` re-sends the
 * message.
 *
 * An array `text` is posted as one message per element, each still split at
 * the limit; the caller uses it when its own markup must not be cut in two.
 *
 * `replyToMessageId` anchors the first chunk to that message on a thread
 * target. Telegram sends it with `allow_sending_without_reply`, so a deleted
 * target still gets the message, unthreaded.
 */
export async function postChatMessage(args: {
  adapter: string;
  threadId?: string;
  channelId?: string;
  text: string | readonly string[];
  taskId?: string;
  replyToMessageId?: string;
}): Promise<ChatPostResult> {
  // Ids come from tools and stored context keys. Check the Teams origin
  // before the adapter sends its token.
  assertTrustedChatTarget(args.threadId ?? args.channelId ?? "");
  const chat = getChatInstance(args.adapter);
  if (!chat) throw new ChatAdapterUnavailableError(args.adapter);
  const parts = (typeof args.text === "string" ? [args.text] : args.text).map(scrubSecrets);
  const text = parts.join("\n\n");

  let result: ChatPostResult;
  if (args.threadId) {
    const thread = chat.thread(args.threadId);
    // Only adapters with a native reply (Telegram in this SDK version) anchor;
    // the others post unanchored, as before.
    const replyTo = args.replyToMessageId;
    const sent = await postChunks(
      args.adapter,
      thread,
      parts,
      replyTo && thread.adapter.reply ? (message) => thread.reply(replyTo, message) : undefined,
    );
    result = {
      adapter: args.adapter,
      threadId: thread.id,
      channelId: thread.channelId,
      messageIds: sent.messageIds,
    };
  } else if (args.channelId) {
    const channel = chat.channel(args.channelId);
    const sent = await postChunks(args.adapter, channel, parts);
    result = {
      adapter: args.adapter,
      threadId: sent.threadId ?? channel.id,
      channelId: channel.id,
      messageIds: sent.messageIds,
    };
  } else {
    throw new Error("postChatMessage needs a threadId or a channelId");
  }

  emitChatMessageSent({
    adapter: result.adapter,
    channelId: result.channelId,
    threadId: result.threadId,
    text,
    taskId: args.taskId,
    messageId: result.messageIds.at(-1),
  });
  return result;
}
