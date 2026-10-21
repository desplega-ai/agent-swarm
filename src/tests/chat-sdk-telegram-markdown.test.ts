import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { escapeTelegramHashLines, postChatMessage } from "../integrations/chat-sdk/outbound";
import { startTelegramHarness, type TelegramHarness } from "./chat-sdk-harness";

describe("escapeTelegramHashLines", () => {
  test("escapes a line-leading # that is not a heading", () => {
    expect(escapeTelegramHashLines("#2203 is still an open draft")).toBe(
      "\\#2203 is still an open draft",
    );
    expect(escapeTelegramHashLines("#tag")).toBe("\\#tag");
    expect(escapeTelegramHashLines("#1 priority")).toBe("\\#1 priority");
    expect(escapeTelegramHashLines("##x")).toBe("\\##x");
  });

  test("keeps CommonMark ATX headings", () => {
    for (const heading of ["# Title", "## Title", "###### Six", "#", "## ", "   # Indented"]) {
      expect(escapeTelegramHashLines(heading)).toBe(heading);
    }
  });

  test("escapes a run of seven or more #", () => {
    expect(escapeTelegramHashLines("####### seven")).toBe("\\####### seven");
    expect(escapeTelegramHashLines("#######")).toBe("\\#######");
  });

  test("leaves a mid-line # alone", () => {
    expect(escapeTelegramHashLines("PR #2203 is open, see #tag")).toBe(
      "PR #2203 is open, see #tag",
    );
  });

  test("escapes after a paragraph, a bold line, list and quote markers", () => {
    expect(escapeTelegramHashLines("Status:\n#2203 open")).toBe("Status:\n\\#2203 open");
    expect(escapeTelegramHashLines("**Status**\n#2203 open")).toBe("**Status**\n\\#2203 open");
    expect(escapeTelegramHashLines("- #2203 open")).toBe("- \\#2203 open");
    expect(escapeTelegramHashLines("1. #2203 open")).toBe("1. \\#2203 open");
    expect(escapeTelegramHashLines("- [ ] #2203 open")).toBe("- [ ] \\#2203 open");
    expect(escapeTelegramHashLines("> #2203 open")).toBe("> \\#2203 open");
  });

  test("leaves fenced code alone", () => {
    const text = "```sh\n#!/bin/sh\n#2203\n```\n#2203 after";
    expect(escapeTelegramHashLines(text)).toBe("```sh\n#!/bin/sh\n#2203\n```\n\\#2203 after");
    expect(escapeTelegramHashLines("~~~\n#x\n```\n#y\n~~~\n#z")).toBe(
      "~~~\n#x\n```\n#y\n~~~\n\\#z",
    );
  });

  test("the MarkdownV2 fallback renders the escape as a literal #", () => {
    const adapter = createTelegramAdapter({
      botToken: "t",
      mode: "webhook",
      secretToken: "s",
    } as Parameters<typeof createTelegramAdapter>[0]) as unknown as {
      formatConverter: { fromMarkdown(markdown: string): string };
    };
    const render = (text: string) =>
      adapter.formatConverter.fromMarkdown(escapeTelegramHashLines(text));
    expect(render("#2203 is still an open draft")).toBe("\\#2203 is still an open draft");
    expect(render("# Title")).toBe("*Title*");
  });
});

describe("Telegram outbound markdown", () => {
  let harness: TelegramHarness;

  beforeAll(async () => {
    harness = await startTelegramHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function sentMarkdown(text: string): Promise<string | undefined> {
    const before = harness.mock.calls.length;
    await postChatMessage({ adapter: "telegram", threadId: "telegram:4242", text });
    const send = harness.mock.calls.slice(before).find((call) => call.method === "sendRichMessage");
    return (send?.body.rich_message as { markdown?: string } | undefined)?.markdown;
  }

  test("a line-leading #2203 reaches sendRichMessage escaped; headings do not", async () => {
    expect(await sentMarkdown("#2203 is still an open draft...")).toBe(
      "\\#2203 is still an open draft...",
    );
    expect(await sentMarkdown("Done.\n#2203 is still an open draft...")).toBe(
      "Done.\n\\#2203 is still an open draft...",
    );
    expect(await sentMarkdown("# Title\n## Sub\nPR #2203")).toBe("# Title\n## Sub\nPR #2203");
  });
});
