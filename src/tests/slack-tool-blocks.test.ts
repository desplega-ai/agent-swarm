import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getSlackMessageByChannelTs,
  getSlackTreeMessage,
  initDb,
  recordSlackMessage,
} from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import { registerSlackPostTool } from "../tools/slack-post";
import { registerSlackReplyTool } from "../tools/slack-reply";
import { registerSlackStartThreadTool } from "../tools/slack-start-thread";

const TEST_DB_PATH = "./test-slack-tool-blocks.sqlite";
let lastPostedTs = "300.2";
let postCounter = 2;
const mockChatPostMessage = mock(() => Promise.resolve({ ok: true, ts: lastPostedTs }));

mock.module("../slack/app", () => ({
  getSlackApp: () => ({ client: { chat: { postMessage: mockChatPostMessage } } }),
}));

type ToolResult = {
  structuredContent: { success: boolean; message: string; messageTs?: string };
};
type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
};

function buildTools() {
  const server = new McpServer({ name: "slack-tool-blocks-test", version: "1.0.0" });
  registerSlackPostTool(server);
  registerSlackReplyTool(server);
  registerSlackStartThreadTool(server);
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function meta(agentId: string, sourceTaskId?: string) {
  return {
    sessionId: "s1",
    requestInfo: {
      headers: {
        "x-agent-id": agentId,
        ...(sourceTaskId ? { "x-source-task-id": sourceTaskId } : {}),
      },
    },
  };
}

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

let leadId: string;
let workerId: string;
let taskId: string;
let contextKey: string;

beforeAll(async () => {
  await removeDbFiles();
  process.env.APP_URL = "https://app.agent-swarm.dev";
  initDb(TEST_DB_PATH);
  leadId = createAgent({ name: "Lead Blocks", isLead: true, status: "idle" }).id;
  workerId = createAgent({ name: "Researcher Blocks", isLead: false, status: "idle" }).id;
  contextKey = slackContextKey({ channelId: "C_BLOCKS", threadTs: "300.1" });
  taskId = createTaskExtended("test blocks", {
    agentId: workerId,
    source: "slack",
    slackChannelId: "C_BLOCKS",
    slackThreadTs: "300.1",
    contextKey,
  }).id;
  recordSlackMessage({
    contextKey,
    channelId: "C_BLOCKS",
    threadTs: "300.1",
    ts: "300.tree",
    kind: "tree",
    taskId,
    permalink: "https://workspace.slack.com/archives/C_BLOCKS/p300tree",
    finalized: true,
  });
});

beforeEach(() => {
  mockChatPostMessage.mockClear();
  lastPostedTs = `300.${++postCounter}`;
  mockChatPostMessage.mockImplementation(() => Promise.resolve({ ok: true, ts: lastPostedTs }));
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("Slack tool Block Kit support", () => {
  test("slack-reply preserves supplied blocks and appends only the compact provenance footer", async () => {
    const tools = buildTools();
    const supplied = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Custom result*" },
      },
    ];
    const result = await tools["slack-reply"]!.handler(
      { taskId, message: "fallback", blocks: supplied },
      meta(workerId),
    );

    expect(result.structuredContent.success).toBe(true);
    const payload = mockChatPostMessage.mock.calls[0]![0];
    expect(payload.text).toBe("fallback");
    expect(payload.blocks[0]).toEqual(supplied[0]);
    expect(payload.blocks[1]).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Researcher Blocks · <https://app.agent-swarm.dev/tasks/${taskId}|\`${taskId.slice(0, 8)}\`> · <https://workspace.slack.com/archives/C_BLOCKS/p300tree|↑ tree>`,
        },
      ],
    });
    expect(getSlackMessageByChannelTs("C_BLOCKS", lastPostedTs)?.kind).toBe("agent");
  });

  test("slack-post preserves supplied blocks end to end and records agent provenance", async () => {
    const tools = buildTools();
    const supplied = [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "small gray footer" }],
      },
    ];
    const result = await tools["slack-post"]!.handler(
      { channelId: "C_DIRECT", message: "fallback", blocks: supplied },
      meta(leadId),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(mockChatPostMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C_DIRECT",
      text: "fallback",
      blocks: supplied,
    });
    expect(getSlackTreeMessage(contextKey)?.kind).toBe("tree");
    expect(getSlackMessageByChannelTs("C_DIRECT", lastPostedTs)?.kind).toBe("agent");
  });

  test("slack-start-thread preserves supplied blocks and records the explicit agent message", async () => {
    const tools = buildTools();
    const supplied = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*New explicit thread*" },
      },
    ];
    const result = await tools["slack-start-thread"]!.handler(
      { channelId: "C_START", message: "fallback", blocks: supplied },
      meta(leadId),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(mockChatPostMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C_START",
      text: "fallback",
      blocks: supplied,
    });
    expect(getSlackMessageByChannelTs("C_START", lastPostedTs)?.kind).toBe("agent");
  });

  test("rejects 50 supplied blocks when the task provenance footer would exceed Slack's cap", async () => {
    const tools = buildTools();
    const blocks = Array.from({ length: 50 }, (_, index) => ({
      type: "section",
      text: { type: "mrkdwn", text: `block ${index}` },
    }));
    const result = await tools["slack-reply"]!.handler(
      { taskId, message: "fallback", blocks },
      meta(workerId),
    );

    expect(result.structuredContent.success).toBe(false);
    expect(mockChatPostMessage).not.toHaveBeenCalled();
  });
});
