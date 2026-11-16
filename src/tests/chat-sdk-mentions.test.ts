import { describe, expect, test } from "bun:test";
import { slackMrkdwnToMarkdown } from "@chat-adapter/slack/format";
import { teamsHtmlToMarkdown } from "@chat-adapter/teams/format";
import { TelegramFormatConverter } from "@chat-adapter/telegram";
import type { Adapter, Logger, Message } from "chat";
import { parseMarkdown } from "chat";
import { loadAdapter } from "../integrations/chat-sdk/adapters";
import { botMentionForms, stripBotMention } from "../integrations/chat-sdk/mentions";
import { chatMessageText } from "../integrations/chat-sdk/message-text";

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
} as unknown as Logger;

/** The handler-side text for `message`: what inbound.ts hands the router. */
async function inboundText(adapter: Adapter, message: Message): Promise<string> {
  return stripBotMention(chatMessageText(message), await botMentionForms(adapter, message));
}

/** A message as the SDK builds it, from markdown the adapter produced. */
function messageFromMarkdown(markdown: string, raw: unknown = {}): Message {
  return { text: markdown, formatted: parseMarkdown(markdown), raw } as unknown as Message;
}

describe("Discord mentions", () => {
  const BOT = "1511371327469129869";

  async function discordAdapter(): Promise<{ adapter: Adapter; received: Message[] }> {
    const adapter = await loadAdapter(
      "discord",
      { botToken: "discord-bot-token", publicKey: "a".repeat(64), applicationId: BOT },
      silent,
    );
    const received: Message[] = [];
    (adapter as unknown as { chat: unknown }).chat = {
      handleIncomingMessage: async (_adapter: unknown, _threadId: string, message: Message) => {
        received.push(message);
      },
    };
    return { adapter, received };
  }

  /** A discord.js Gateway message in an existing thread, with its mention collections. */
  function gatewayMessage(content: string) {
    return {
      id: "1600000000000000001",
      guildId: "1400000000000000000",
      channelId: "1500000000000000002",
      channel: { isThread: () => true, parentId: "1500000000000000001" },
      content,
      attachments: new Map(),
      messageSnapshots: new Map(),
      author: { id: "1300000000000000001", username: "taras", displayName: "Taras", bot: false },
      createdAt: new Date("2026-11-16T10:00:00Z"),
      editedAt: null,
      mentions: {
        users: new Map([
          [BOT, { displayName: "swarm", username: "swarm" }],
          ["1300000000000000002", { displayName: "Eze Global", username: "eze" }],
        ]),
        members: new Map([["1300000000000000002", { displayName: "Eze" }]]),
        roles: new Map([["1700000000000000001", { name: "oncall" }]]),
        channels: new Map([["1500000000000000009", { name: "deploys" }]]),
      },
    };
  }

  async function deliver(content: string): Promise<{ adapter: Adapter; message: Message }> {
    const { adapter, received } = await discordAdapter();
    await (
      adapter as unknown as { handleGatewayMessage(m: unknown, mentioned: boolean): Promise<void> }
    ).handleGatewayMessage(gatewayMessage(content), true);
    expect(received).toHaveLength(1);
    return { adapter, message: received[0] as Message };
  }

  test("strips the bot mention and resolves user, role and channel names", async () => {
    const { adapter, message } = await deliver(
      `<@${BOT}> ask <@1300000000000000002> and <@&1700000000000000001> about <#1500000000000000009>`,
    );
    expect(await inboundText(adapter, message)).toBe("ask @Eze and @oncall about #deploys");
  });

  test("the legacy <@!id> nickname form strips too", async () => {
    const { adapter, message } = await deliver(`<@!${BOT}> status?`);
    expect(await inboundText(adapter, message)).toBe("status?");
  });

  test("negative control: an id with no name stays as @id, never dropped", async () => {
    const { adapter, message } = await deliver(`<@${BOT}> ping <@1300000000000000077> now`);
    expect(await inboundText(adapter, message)).toBe("ping @1300000000000000077 now");
  });

  test("bare @id form (adapter output) strips only the exact bot id", () => {
    const forms = { names: ["swarm"], ids: [BOT] };
    expect(stripBotMention(`@${BOT} hi`, forms)).toBe("hi");
    expect(stripBotMention(`@${BOT}0 hi`, forms)).toBe(`@${BOT}0 hi`);
    expect(stripBotMention(`@&${BOT} hi`, forms)).toBe(`@&${BOT} hi`);
  });
});

describe("Slack mentions", () => {
  const slack = (displayName: string | null) =>
    ({
      name: "slack",
      userName: "agent_swarm",
      botUserId: "U0BOT",
      lookupUser: async (id: string) => (id === "U0BOT" && displayName ? { displayName } : null),
    }) as unknown as Adapter;

  test("strips the bot mention rendered under its display name", async () => {
    // The adapter rewrites <@U0BOT> to <@U0BOT|display name> before converting.
    const markdown = slackMrkdwnToMarkdown("<@U0BOT|Agent Swarm> ask <@U0BOB|Bob> to review");
    const message = messageFromMarkdown(markdown);
    expect(await inboundText(slack("Agent Swarm"), message)).toBe("ask @Bob to review");
  });

  test("negative control: another user's display name stays", async () => {
    const markdown = slackMrkdwnToMarkdown("<@U0BOB|Bob> can you check?");
    expect(await inboundText(slack("Agent Swarm"), messageFromMarkdown(markdown))).toBe(
      "@Bob can you check?",
    );
  });

  test("a failed lookup still strips the handle form", async () => {
    const markdown = slackMrkdwnToMarkdown("@agent_swarm hi");
    expect(await inboundText(slack(null), messageFromMarkdown(markdown))).toBe("hi");
  });
});

describe("Teams mentions", () => {
  const APP = "00000000-0000-0000-0000-00000000a99";
  const teams = { name: "teams", userName: "swarm", botUserId: `28:${APP}` } as unknown as Adapter;

  function activity(text: string, entities: unknown[]) {
    return {
      type: "message",
      text,
      from: { id: "29:user-1", name: "Tester" },
      recipient: { id: `28:${APP}`, name: "Agent Swarm" },
      entities,
    };
  }

  test("strips the bot mention whose display name differs from userName", async () => {
    const bot = { id: `28:${APP}`, name: "Agent Swarm" };
    const raw = activity("<at>Agent Swarm</at> triage with <at>Dana</at>", [
      { type: "mention", mentioned: bot, text: "<at>Agent Swarm</at>" },
      { type: "mention", mentioned: { id: "29:user-2", name: "Dana" }, text: "<at>Dana</at>" },
    ]);
    const message = messageFromMarkdown(teamsHtmlToMarkdown(raw.text), raw);
    expect(await inboundText(teams, message)).toBe("triage with @Dana");
  });

  test("negative control: a user mention with no bot entity stays", async () => {
    const raw = activity("<at>Dana</at> ping", [
      { type: "mention", mentioned: { id: "29:user-2", name: "Dana" }, text: "<at>Dana</at>" },
    ]);
    const message = messageFromMarkdown(teamsHtmlToMarkdown(raw.text), raw);
    expect(await inboundText(teams, message)).toBe("@Dana ping");
  });
});

describe("Telegram and Rocket.Chat mentions", () => {
  test("Telegram: @bot_username strips, @other stays", async () => {
    const telegram = { name: "telegram", userName: "swarm_bot", botUserId: "8000000001" };
    const parsed = new TelegramFormatConverter().parseIncoming("@swarm_bot ask @alice");
    const message = { text: parsed.text, formatted: parsed.formatted, raw: {} } as Message;
    expect(await inboundText(telegram as unknown as Adapter, message)).toBe("ask @alice");
  });

  test("Rocket.Chat: @my-bot strips, @my-bot-two stays", async () => {
    const rocket = { name: "rocketchat", userName: "my-bot", botUserId: "rcBotId" };
    const message = messageFromMarkdown("@my-bot hi @my-bot-two");
    expect(await inboundText(rocket as unknown as Adapter, message)).toBe("hi @my-bot-two");
  });
});
