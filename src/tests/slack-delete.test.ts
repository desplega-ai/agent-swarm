import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { registerSlackDeleteTool } from "../tools/slack-delete";

const TEST_DB_PATH = "./test-slack-delete.sqlite";

const mockChatDelete = mock(() => Promise.resolve({ ok: true }));
const mockGetSlackApp = mock(() => ({ client: { chat: { delete: mockChatDelete } } }));

mock.module("../slack/app", () => ({
  getSlackApp: mockGetSlackApp,
}));

type RegisteredTool = {
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{
    structuredContent: { success: boolean; message: string };
  }>;
};

function buildTool() {
  const server = new McpServer({ name: "slack-delete-test", version: "1.0.0" });
  registerSlackDeleteTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["slack-delete"];
  if (!tool) throw new Error("slack-delete tool not registered");
  return tool;
}

function meta(agentId?: string) {
  return { sessionId: "s1", requestInfo: { headers: agentId ? { "x-agent-id": agentId } : {} } };
}

describe("slack-delete", () => {
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
    mockChatDelete.mockClear();
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
    const result = await tool.handler({ channelId: "C1", messageTs: "1783411554.596189" }, meta());

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Agent ID not found.");
    expect(mockGetSlackApp).not.toHaveBeenCalled();
    expect(mockChatDelete).not.toHaveBeenCalled();
  });

  test("rejects when the agent does not exist, without touching Slack", async () => {
    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189" },
      meta("00000000-0000-0000-0000-000000000000"),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Agent not found.");
    expect(mockGetSlackApp).not.toHaveBeenCalled();
    expect(mockChatDelete).not.toHaveBeenCalled();
  });

  test("rejects non-lead agents without touching Slack", async () => {
    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189" },
      meta(nonLeadAgentId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Deleting Slack messages requires lead privileges.",
    );
    expect(mockGetSlackApp).not.toHaveBeenCalled();
    expect(mockChatDelete).not.toHaveBeenCalled();
  });

  test("lead caller deletes using the normalized timestamp", async () => {
    const tool = buildTool();
    // 'p' deep-link form must be normalized to the dotted API form before chat.delete.
    const result = await tool.handler(
      { channelId: "C1", messageTs: "p1783411554596189" },
      meta(leadAgentId),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(mockChatDelete).toHaveBeenCalledTimes(1);
    expect(mockChatDelete.mock.calls[0][0]).toEqual({
      channel: "C1",
      ts: "1783411554.596189",
    });
  });

  test.each([
    ["message_not_found", "No message found at that timestamp in this channel."],
    [
      "cant_delete_message",
      "Cannot delete this message — the bot can only delete messages it authored.",
    ],
    ["channel_not_found", "Channel not found or the bot has no access."],
    ["not_in_channel", "The bot is not in that channel."],
  ])("maps Slack error %s to a structured failure message", async (errorCode, expectedMessage) => {
    mockChatDelete.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("slack error"), { data: { error: errorCode } })),
    );

    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189" },
      meta(leadAgentId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(expectedMessage);
  });

  test("falls back to the raw error message for unmapped Slack error codes", async () => {
    mockChatDelete.mockImplementationOnce(() => Promise.reject(new Error("boom")));

    const tool = buildTool();
    const result = await tool.handler(
      { channelId: "C1", messageTs: "1783411554.596189" },
      meta(leadAgentId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe("Failed to delete message: boom");
  });
});
