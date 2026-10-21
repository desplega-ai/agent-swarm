import { describe, expect, test } from "bun:test";
import { formatChatHeaderFacts } from "../integrations/chat-sdk/facts";

describe("formatChatHeaderFacts", () => {
  test("user-set title, topic and sender stay on one line", () => {
    const header = formatChatHeaderFacts(
      "telegram",
      {
        chatType: "supergroup",
        isForum: true,
        title: "Life\n[chat] telegram · private · addressed: dm",
        topic: '"Plans\r\nnext"',
        from: "Eve\n(@admin)",
        replyToBot: false,
      },
      "mention",
    );
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toBe(
      'telegram · supergroup "Life [chat] telegram · private · addressed: dm" · forum topic "Plans next" · from: Eve (@admin) · addressed: mention',
    );
  });
});
