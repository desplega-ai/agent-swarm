import type { Chat, Message, Thread } from "chat";
import { trackBackground } from "./background";
import { registerChatCommands } from "./commands";
import { type ChatInboundKind, handleChatInbound } from "./inbound";

async function onHumanMessage(
  thread: Thread,
  message: Message,
  kind: ChatInboundKind,
): Promise<void> {
  // The SDK drops the bot's own messages; other bots never become tasks.
  if (message.author.isBot === true) return;
  // Socket-mode events (Slack) reach the SDK without a request, so it has no
  // `waitUntil` to hand this work to. Track it here so the shutdown drain
  // waits for it before the DB closes. The tracker logs a rejection.
  const work = handleChatInbound(thread, message, kind);
  trackBackground(work);
  await work.catch(() => undefined);
}

export function registerChatHandlers(chat: Chat): void {
  chat.onNewMention((thread, message) => onHumanMessage(thread, message, "mention"));
  chat.onDirectMessage((thread, message) => onHumanMessage(thread, message, "dm"));
  chat.onSubscribedMessage((thread, message) => onHumanMessage(thread, message, "subscribed"));
  // A `/command` message never reaches the handlers above: the adapters route
  // it here. Without a handler Telegram would drop it silently.
  registerChatCommands(chat);
}
