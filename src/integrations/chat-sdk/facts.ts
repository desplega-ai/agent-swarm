import type { Message, Thread } from "chat";

/** Why a message counts as meant for the swarm. `none`: it reached the router unaddressed. */
export type ChatAddressedReason =
  | "dm"
  | "mention"
  | "reply-to-bot"
  | "requester-follow-up"
  | "none";

/**
 * Facts about one inbound message that only core can read: the chat it came
 * from (Telegram `message.raw.chat`) and whether it answers the bot.
 */
export interface ChatMessageFacts {
  /** Platform chat type, such as Telegram `private`, `group` or `supergroup`. */
  chatType?: string;
  isForum?: boolean;
  /** Group or channel title. */
  title?: string;
  /** Forum topic: `"<name>"` when the update carries it, else `#<thread id>`. */
  topic?: string;
  /** The sender as people know them: `Name (@username)`. */
  from: string;
  /** The message replies to one of the bot's own messages. */
  replyToBot: boolean;
  /** Start of the message it replies to. */
  replyToSnippet?: string;
}

const SNIPPET_MAX = 80;

export interface TelegramRawMessage {
  message_id?: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat?: { type?: string; title?: string; is_forum?: boolean };
  from?: { first_name?: string; last_name?: string; username?: string };
  reply_to_message?: {
    message_id?: number;
    from?: { id?: number | string };
    text?: string;
    caption?: string;
    forum_topic_created?: { name?: string };
  };
}

function snippet(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}...` : flat;
}

function personLabel(name: string | undefined, username: string | undefined, fallback: string) {
  if (name && username && name !== username) return `${name} (@${username})`;
  if (username) return `@${username}`;
  return name || fallback;
}

/**
 * In a forum topic every plain message replies to the topic's creation
 * message, so that reply is the topic, not an answer to anyone. Only
 * `is_topic_message` marks a topic: a plain supergroup reply also carries
 * `message_thread_id`, the id of its reply chain's first message.
 */
function replyIsTopicRoot(raw: TelegramRawMessage): boolean {
  const reply = raw.reply_to_message;
  return (
    reply !== undefined &&
    (reply.forum_topic_created !== undefined ||
      (raw.is_topic_message === true && reply.message_id === raw.message_thread_id))
  );
}

/** The raw Telegram message replies to one of the bot's own messages, not to a forum topic root. */
export function isTelegramReplyToBot(raw: TelegramRawMessage, botUserId?: string): boolean {
  const fromId = raw.reply_to_message?.from?.id;
  return (
    !replyIsTopicRoot(raw) &&
    fromId !== undefined &&
    botUserId !== undefined &&
    String(fromId) === botUserId
  );
}

function telegramFacts(raw: TelegramRawMessage, message: Message, botUserId?: string) {
  const reply = raw.reply_to_message;
  const topicRoot = replyIsTopicRoot(raw);
  const realReply = reply && !topicRoot ? reply : undefined;
  const topicName = topicRoot ? reply?.forum_topic_created?.name : undefined;
  const name = [raw.from?.first_name, raw.from?.last_name].filter(Boolean).join(" ").trim();
  return {
    chatType: raw.chat?.type,
    isForum: raw.chat?.is_forum === true ? true : undefined,
    title: raw.chat?.title,
    topic:
      raw.is_topic_message === true && raw.message_thread_id !== undefined
        ? topicName
          ? `"${topicName}"`
          : `#${raw.message_thread_id}`
        : undefined,
    from: personLabel(name || undefined, raw.from?.username, message.author.userId),
    replyToBot: isTelegramReplyToBot(raw, botUserId),
    replyToSnippet: snippet(realReply?.text ?? realReply?.caption),
  } satisfies ChatMessageFacts;
}

/** Read the chat facts of one message. Telegram reads the raw update; other adapters the SDK message. */
export function readChatMessageFacts(thread: Thread, message: Message): ChatMessageFacts {
  const raw = message.raw as TelegramRawMessage | undefined;
  if (thread.adapter.name === "telegram" && raw && typeof raw === "object") {
    return telegramFacts(raw, message, thread.adapter.botUserId);
  }
  const { fullName, userName, userId } = message.author;
  return {
    chatType: thread.isDM ? "dm" : undefined,
    from: personLabel(fullName || undefined, userName || undefined, userId),
    replyToBot: message.replyTo?.author.isMe === true,
    replyToSnippet: snippet(message.replyTo?.text),
  };
}

/** One line of facts for the task header: `telegram · supergroup "Life" · from: ... · addressed: ...`. */
export function formatChatHeaderFacts(
  adapter: string,
  facts: ChatMessageFacts,
  addressed: ChatAddressedReason,
): string {
  // Title, topic and sender are user-set: one line each, so none can forge a header line.
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const parts = [adapter];
  if (facts.chatType)
    parts.push(facts.title ? `${facts.chatType} "${oneLine(facts.title)}"` : facts.chatType);
  if (facts.isForum) parts.push(facts.topic ? `forum topic ${oneLine(facts.topic)}` : "forum");
  parts.push(`from: ${oneLine(facts.from)}`, `addressed: ${addressed}`);
  if (facts.replyToSnippet) parts.push(`reply-to: "${facts.replyToSnippet}"`);
  return parts.join(" · ");
}
