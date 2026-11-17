/** Validate a topic ID before the adapter's permissive parseInt can change its destination. */
export function assertTelegramTopicThreadId(threadId: string, channelId?: string): void {
  const match = /^telegram:([^:]+):([1-9]\d*)$/.exec(threadId);
  if (!match || match[1] === "biz" || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error(
      "Invalid Telegram topic threadId. Use telegram:<chatId>:<positive integer topicId>.",
    );
  }
  if (channelId !== undefined && `telegram:${match[1]}` !== channelId) {
    throw new Error("The default Telegram topic must belong to the registered channel.");
  }
}
