import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { resetExternalChannelStateForTesting } from "../slack/external-channel";
import { registerSlackPostTool } from "../tools/slack-post";
import { registerSlackReadTool } from "../tools/slack-read";
import { registerSlackReplyTool } from "../tools/slack-reply";
import { registerSlackStartThreadTool } from "../tools/slack-start-thread";
import { registerSlackUpdateTool } from "../tools/slack-update";
import { registerSlackUploadFileTool } from "../tools/slack-upload-file";

const TEST_DB_PATH = "./test-slack-external-channel-tools.sqlite";
const originalFlag = process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;

const EXT_CHANNEL = "C_EXT_TOOLS";
let channelInfo: Record<string, unknown> = { is_ext_shared: true };
let infoFails = false;

const mockPostMessage = mock(() =>
  Promise.resolve({ ok: true, ts: "500.2", channel: EXT_CHANNEL }),
);
const mockInfo = mock(() =>
  infoFails
    ? Promise.reject(new Error("An API error occurred: missing_scope"))
    : Promise.resolve({ ok: true, channel: channelInfo }),
);
const mockUpdate = mock(() => Promise.resolve({ ok: true, ts: "500.2", channel: EXT_CHANNEL }));
const mockUpload = mock(() => Promise.resolve({ ok: true, files: [{ files: [{ id: "F1" }] }] }));
const mockReplies = mock(() => Promise.resolve({ ok: true, messages: [] }));
const mockHistory = mock(() => Promise.resolve({ ok: true, messages: [] }));

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      chat: { postMessage: mockPostMessage, update: mockUpdate },
      filesUploadV2: mockUpload,
      conversations: { info: mockInfo, replies: mockReplies, history: mockHistory },
      users: { info: () => Promise.resolve({ ok: true, user: {} }) },
      auth: { test: () => Promise.resolve({ ok: true, user_id: "U_BOT", bot_id: "B_BOT" }) },
    },
  }),
}));

type ToolResult = {
  isError?: boolean;
  structuredContent: { success: boolean; message: string };
};
type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };

function buildTools() {
  const server = new McpServer({ name: "slack-external-channel-tools-test", version: "1.0.0" });
  registerSlackPostTool(server);
  registerSlackReplyTool(server);
  registerSlackStartThreadTool(server);
  registerSlackReadTool(server);
  registerSlackUpdateTool(server);
  registerSlackUploadFileTool(server);
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
let taskId: string;
let tools: Record<string, RegisteredTool>;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "Lead Ext Tools", isLead: true, status: "idle" })).id;
  taskId = (
    await createTaskExtended("ext tools", {
      agentId: leadId,
      source: "slack",
      slackChannelId: EXT_CHANNEL,
      slackThreadTs: "500.1",
    })
  ).id;
  tools = buildTools();
});

beforeEach(() => {
  resetExternalChannelStateForTesting();
  channelInfo = { is_ext_shared: true };
  infoFails = false;
  mockPostMessage.mockClear();
  mockUpdate.mockClear();
  mockUpload.mockClear();
  mockInfo.mockClear();
  mockReplies.mockClear();
  mockHistory.mockClear();
});

afterAll(async () => {
  if (originalFlag === undefined) delete process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;
  else process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = originalFlag;
  closeDb();
  await removeDbFiles();
});

const calls: Array<[string, () => Record<string, unknown>]> = [
  ["slack-post", () => ({ channelId: EXT_CHANNEL, message: "hi" })],
  ["slack-start-thread", () => ({ channelId: EXT_CHANNEL, message: "hi" })],
  ["slack-reply", () => ({ taskId, message: "hi" })],
  ["slack-read", () => ({ channelId: EXT_CHANNEL })],
  ["slack-update", () => ({ channelId: EXT_CHANNEL, messageTs: "500.2", message: "hi" })],
  [
    "slack-upload-file",
    () => ({
      channelId: EXT_CHANNEL,
      content: Buffer.from("hi").toString("base64"),
      filename: "hi.txt",
    }),
  ],
];

function slackWriteCount(): number {
  return (
    mockPostMessage.mock.calls.length +
    mockHistory.mock.calls.length +
    mockUpdate.mock.calls.length +
    mockUpload.mock.calls.length
  );
}

describe("outbound guard (E8)", () => {
  test.each(calls)("%s: flag true + external channel is refused", async (name, args) => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    const result = await tools[name]!.handler(args(), meta(leadId));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain(
      "SLACK_BLOCK_EXTERNAL_CHANNELS blocks swarm messages there",
    );
    expect(slackWriteCount()).toBe(0);
  });

  test.each(calls)("%s: flag true + conversations.info failure is refused", async (name, args) => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    infoFails = true;
    const result = await tools[name]!.handler(args(), meta(leadId));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("Could not verify that channel");
    expect(slackWriteCount()).toBe(0);
  });

  test.each(calls)("%s: flag true + verified internal channel proceeds", async (name, args) => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    channelInfo = { is_ext_shared: false };
    const result = await tools[name]!.handler(args(), meta(leadId));
    expect(result.isError).toBeFalsy();
    expect(slackWriteCount()).toBe(1);
  });

  test.each(calls)("%s: flag false keeps the current behavior", async (name, args) => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    const result = await tools[name]!.handler(args(), meta(leadId));
    expect(result.isError).toBeFalsy();
    expect(mockInfo).not.toHaveBeenCalled();
    expect(slackWriteCount()).toBe(1);
  });
});
