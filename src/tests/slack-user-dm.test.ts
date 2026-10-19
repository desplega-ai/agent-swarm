import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getSlackMessageByChannelTs, initDb } from "../be/db";
import { isSlackUserId } from "../slack/dm";
import { registerSlackPostTool } from "../tools/slack-post";
import { registerSlackReadTool } from "../tools/slack-read";
import { registerSlackStartThreadTool } from "../tools/slack-start-thread";

const TEST_DB_PATH = "./test-slack-user-dm.sqlite";
const USER_ID = "U08USERDM";
// The bot's own IM with USER_ID: readable, writable, delivers message.im events.
const BOT_DM = "D0BOTDM01";
// Where Slack puts a bot post addressed to the bare user id: the bot is not a member.
const FOREIGN_DM = "D0FOREIGN";

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { ok: false, error: code },
  });
}

let tsCounter = 0;
const postMessage = mock(async (args: { channel: string; thread_ts?: string }) => {
  if (args.channel === FOREIGN_DM) throw slackError("channel_not_found");
  const ts = `500.${++tsCounter}`;
  return { ok: true, ts, channel: args.channel === USER_ID ? FOREIGN_DM : args.channel };
});
const conversationsOpen = mock(async (args: { users: string }) => {
  if (args.users !== USER_ID) throw slackError("user_not_found");
  return { ok: true, channel: { id: BOT_DM } };
});
const conversationsReplies = mock(async (args: { channel: string; ts: string }) => {
  if (args.channel !== BOT_DM) throw slackError("channel_not_found");
  return { ok: true, messages: [{ user: USER_ID, text: "reply from human", ts: args.ts }] };
});

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      chat: { postMessage },
      conversations: { open: conversationsOpen, replies: conversationsReplies },
      auth: { test: async () => ({ ok: true, user_id: "UBOT" }) },
      users: { info: async () => ({ ok: true, user: { real_name: "Human" } }) },
    },
  }),
}));

type ToolResult = {
  structuredContent: {
    success: boolean;
    message: string;
    channelId?: string;
    ts?: string;
    messages?: Array<{ text: string }>;
  };
};
type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

function buildTools() {
  const server = new McpServer({ name: "slack-user-dm-test", version: "1.0.0" });
  registerSlackPostTool(server);
  registerSlackReadTool(server);
  registerSlackStartThreadTool(server);
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function meta(agentId: string) {
  return { sessionId: "s1", requestInfo: { headers: { "x-agent-id": agentId } } };
}

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

let leadId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "Lead DM", isLead: true, status: "idle" })).id;
});

beforeEach(() => {
  postMessage.mockClear();
  conversationsOpen.mockClear();
  conversationsReplies.mockClear();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("Slack tools addressed with a user id", () => {
  test("isSlackUserId matches user ids only", () => {
    expect(isSlackUserId("U08NR6QD6CS")).toBe(true);
    expect(isSlackUserId("W012ABCDEF")).toBe(true);
    expect(isSlackUserId("D0A4T383FMF")).toBe(false);
    expect(isSlackUserId("C0AR967K0KZ")).toBe(false);
    expect(isSlackUserId("G01PRIVATE")).toBe(false);
  });

  test("slack-start-thread opens the bot DM and returns an id that reads and writes work on", async () => {
    const tools = buildTools();

    const started = await tools["slack-start-thread"]!.handler(
      { channelId: USER_ID, message: "hello" },
      meta(leadId),
    );
    expect(started.structuredContent.success).toBe(true);
    expect(conversationsOpen).toHaveBeenCalledWith({ users: USER_ID });
    expect(postMessage.mock.calls[0]![0].channel).toBe(BOT_DM);
    expect(started.structuredContent.channelId).toBe(BOT_DM);
    const threadTs = started.structuredContent.ts!;
    // The recorded message points at the bot DM, so inbound replies match it.
    expect((await getSlackMessageByChannelTs(BOT_DM, threadTs))?.threadTs).toBe(threadTs);

    const posted = await tools["slack-post"]!.handler(
      { channelId: BOT_DM, threadTs, message: "follow-up" },
      meta(leadId),
    );
    expect(posted.structuredContent.success).toBe(true);
    expect(postMessage.mock.calls[1]![0]).toMatchObject({ channel: BOT_DM, thread_ts: threadTs });

    const read = await tools["slack-read"]!.handler({ channelId: BOT_DM, threadTs }, meta(leadId));
    expect(read.structuredContent.success).toBe(true);
    expect(read.structuredContent.messages?.[0]?.text).toContain("reply from human");
  });

  test("slack-post and slack-read with the user id resolve to the same bot DM", async () => {
    const tools = buildTools();

    const posted = await tools["slack-post"]!.handler(
      { channelId: USER_ID, threadTs: "500.1", message: "by user id" },
      meta(leadId),
    );
    expect(posted.structuredContent.success).toBe(true);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ channel: BOT_DM, thread_ts: "500.1" });

    const read = await tools["slack-read"]!.handler(
      { channelId: USER_ID, threadTs: "500.1" },
      meta(leadId),
    );
    expect(read.structuredContent.success).toBe(true);
    expect(conversationsReplies.mock.calls[0]![0].channel).toBe(BOT_DM);
  });

  test("conversation ids pass through without opening a DM", async () => {
    const tools = buildTools();

    const started = await tools["slack-start-thread"]!.handler(
      { channelId: "C0CHANNEL1", message: "channel post" },
      meta(leadId),
    );
    expect(started.structuredContent.channelId).toBe("C0CHANNEL1");
    expect(postMessage.mock.calls[0]![0].channel).toBe("C0CHANNEL1");
    expect(conversationsOpen).not.toHaveBeenCalled();
  });

  test("a user id Slack cannot open a DM with fails without posting", async () => {
    const tools = buildTools();

    const started = await tools["slack-start-thread"]!.handler(
      { channelId: "U0NOBODY1", message: "hello" },
      meta(leadId),
    );
    expect(started.structuredContent.success).toBe(false);
    expect(started.structuredContent.message).toContain("user_not_found");
    expect(postMessage).not.toHaveBeenCalled();
  });
});
