import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { registerSlackUpdateTool } from "../tools/slack-update";

const TEST_DB_PATH = "./test-slack-update.sqlite";

const mockChatUpdate = mock(() => Promise.resolve({ ok: true, ts: "1783411554.596189" }));
const mockGetSlackApp = mock(() => ({ client: { chat: { update: mockChatUpdate } } }));

mock.module("../slack/app", () => ({
  getSlackApp: mockGetSlackApp,
}));

type RegisteredTool = {
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{
    structuredContent: { success: boolean; message: string; messageTs?: string };
  }>;
};

function buildTool() {
  const server = new McpServer({ name: "slack-update-test", version: "1.0.0" });
  registerSlackUpdateTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["slack-update"];
  if (!tool) throw new Error("slack-update tool not registered");
  return tool;
}

function meta(agentId?: string) {
  return { sessionId: "s1", requestInfo: { headers: agentId ? { "x-agent-id": agentId } : {} } };
}

describe("slack-update", () => {
  let leadAgentId: string;
  let nonLeadAgentId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    leadAgentId = createAgent({ name: "Lead", isLead: true, status: "idle" }).id;
    nonLeadAgentId = createAgent({ name: "Worker", isLead: false, status: "idle" }).id;
  });

  beforeEach(() => {
    mockChatUpdate.mockClear();
    mockGetSlackApp.mockClear();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("rejects when agentId header is missing, without touching Slack", async () => {
    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189", message: "corrected" },
      meta(),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Agent ID not found.");
    expect(mockGetSlackApp).not.toHaveBeenCalled();
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });

  test("rejects when the agent does not exist, without touching Slack", async () => {
    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189", message: "corrected" },
      meta("00000000-0000-0000-0000-000000000000"),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Agent not found.");
    expect(mockGetSlackApp).not.toHaveBeenCalled();
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });

  test("rejects non-lead agents without touching Slack", async () => {
    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189", message: "corrected" },
      meta(nonLeadAgentId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Editing Slack messages requires lead privileges.",
    );
    expect(mockGetSlackApp).not.toHaveBeenCalled();
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });

  test("lead caller updates using the normalized timestamp", async () => {
    const tool = buildTool();
    // Full permalink form (with a thread_ts query param) must normalize to the dotted API form.
    const result = await tool.handler(
      {
        channelId: "C1",
        messageTs: "https://x.slack.com/archives/C1/p1783411554596189?thread_ts=123.456",
        message: "corrected message",
      },
      meta(leadAgentId),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.messageTs).toBe("1783411554.596189");
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);
    expect(mockChatUpdate.mock.calls[0][0]).toMatchObject({
      channel: "C1",
      ts: "1783411554.596189",
      text: "corrected message",
    });
  });

  test.each([
    ["message_not_found", "No message found at that timestamp in this channel."],
    [
      "cant_update_message",
      "Cannot edit this message — the bot can only edit messages it authored.",
    ],
    ["edit_window_closed", "The edit window for this message has closed."],
    ["channel_not_found", "Channel not found or the bot has no access."],
    ["not_in_channel", "The bot is not in that channel."],
  ])("maps Slack error %s to a structured failure message", async (errorCode, expectedMessage) => {
    mockChatUpdate.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("slack error"), { data: { error: errorCode } })),
    );

    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189", message: "corrected" },
      meta(leadAgentId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(expectedMessage);
  });

  test("falls back to the raw error message for unmapped Slack error codes", async () => {
    mockChatUpdate.mockImplementationOnce(() => Promise.reject(new Error("boom")));

    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189", message: "corrected" },
      meta(leadAgentId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Failed to update message: boom");
  });
});
