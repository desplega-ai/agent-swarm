import type { Chat, Message, Thread } from "chat";
import { type ChatInboundKind, handleChatInbound } from "./inbound";

async function onHumanMessage(
  thread: Thread,
  message: Message,
  kind: ChatInboundKind,
): Promise<void> {
  // The SDK drops the bot's own messages; other bots never become tasks.
  if (message.author.isBot === true) return;
  await handleChatInbound(thread, message, kind);
}

export function registerChatHandlers(chat: Chat): void {
  chat.onNewMention((thread, message) => onHumanMessage(thread, message, "mention"));
  chat.onDirectMessage((thread, message) => onHumanMessage(thread, message, "dm"));
  chat.onSubscribedMessage((thread, message) => onHumanMessage(thread, message, "subscribed"));
}
