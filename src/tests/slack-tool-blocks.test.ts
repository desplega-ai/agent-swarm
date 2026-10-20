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
import { splitSlackSectionText } from "../slack/blocks";
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
  leadId = (await createAgent({ name: "Lead Blocks", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "Researcher Blocks", isLead: false, status: "idle" })).id;
  contextKey = slackContextKey({ channelId: "C_BLOCKS", threadTs: "300.1" });
  taskId = (
    await createTaskExtended("test blocks", {
      agentId: workerId,
      source: "slack",
      slackChannelId: "C_BLOCKS",
      slackThreadTs: "300.1",
      contextKey,
    })
  ).id;
  await recordSlackMessage({
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

// 3,946 chars of multi-line text: over Slack's 3,000-char section cap, under
// the tools' 4,000-char message cap (the size that failed with invalid_blocks).
const LONG_MESSAGE = Array.from(
  { length: 120 },
  (_, index) => `line ${String(index).padStart(3, "0")} radar item with some words`,
)
  .join("\n")
  .slice(0, 3946);

type PostedBlock = { type: string; text?: { type: string; text: string } };

function expectSplitSections(posted: { text: string; blocks: PostedBlock[] }) {
  const sections = posted.blocks.filter((block) => block.type === "section");
  expect(sections.length).toBeGreaterThanOrEqual(2);
  for (const section of sections) {
    expect(section.text?.type).toBe("mrkdwn");
    expect(section.text!.text.length).toBeLessThanOrEqual(2900);
  }
  // Chunks only drop the whitespace at split points; every other char survives in order.
  const joined = sections.map((section) => section.text!.text).join("");
  expect(joined.replace(/\s/g, "")).toBe(posted.text.replace(/\s/g, ""));
  let cursor = 0;
  for (const section of sections) {
    const at = posted.text.indexOf(section.text!.text, cursor);
    expect(at).toBeGreaterThanOrEqual(cursor);
    cursor = at + section.text!.text.length;
  }
}

describe("Slack tool Block Kit support", () => {
  test("every direct engine Slack post/update disables link and media unfurls", async () => {
    const callSites: Array<{ path: string; line: number; source: string }> = [];
    const glob = new Bun.Glob("src/**/*.ts");
    for await (const path of glob.scan(".")) {
      const lines = (await Bun.file(path).text()).split("\n");
      lines.forEach((line, index) => {
        if (!/chat\.(?:postMessage|update)\(/.test(line)) return;
        callSites.push({
          path,
          line: index + 1,
          source: lines.slice(Math.max(0, index - 24), index + 24).join("\n"),
        });
      });
    }

    expect(callSites.length).toBeGreaterThan(0);
    for (const callSite of callSites) {
      expect({
        callSite: `${callSite.path}:${callSite.line}`,
        unfurlLinksDisabled: callSite.source.includes("unfurl_links: false"),
        unfurlMediaDisabled: callSite.source.includes("unfurl_media: false"),
      }).toMatchObject({ unfurlLinksDisabled: true, unfurlMediaDisabled: true });
    }
  });

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
          text: `Researcher Blocks · <https://app.agent-swarm.dev/tasks/${taskId}|\`${taskId.slice(0, 8)}\`>`,
        },
      ],
    });
    expect(payload).toMatchObject({ unfurl_links: false, unfurl_media: false });
    expect(JSON.stringify(payload.blocks)).not.toContain("↑ tree");
    expect((await getSlackMessageByChannelTs("C_BLOCKS", lastPostedTs))?.kind).toBe("agent");
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
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(mockChatPostMessage.mock.calls[0]![0].blocks).toEqual(supplied);
    expect((await getSlackTreeMessage(contextKey))?.kind).toBe("tree");
    expect((await getSlackMessageByChannelTs("C_DIRECT", lastPostedTs))?.kind).toBe("agent");
  });

  test("slack-reply does not append provenance when the task thread has no v2 tree", async () => {
    const tools = buildTools();
    const noTreeContextKey = slackContextKey({ channelId: "C_NO_REPLY_TREE", threadTs: "400.1" });
    const noTreeTask = await createTaskExtended("reply without tree", {
      agentId: workerId,
      source: "slack",
      slackChannelId: "C_NO_REPLY_TREE",
      slackThreadTs: "400.1",
      contextKey: noTreeContextKey,
    });
    const supplied = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*No tree yet*" },
      },
    ];

    const result = await tools["slack-reply"]!.handler(
      { taskId: noTreeTask.id, message: "fallback", blocks: supplied },
      meta(workerId),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(mockChatPostMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C_NO_REPLY_TREE",
      text: "fallback",
      blocks: supplied,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(mockChatPostMessage.mock.calls[0]![0].blocks).toEqual(supplied);
  });

  test("slack-post does not append provenance when the source task thread has no v2 tree", async () => {
    const tools = buildTools();
    const noTreeContextKey = slackContextKey({ channelId: "C_NO_POST_TREE", threadTs: "500.1" });
    const noTreeTask = await createTaskExtended("post without tree", {
      agentId: leadId,
      source: "slack",
      slackChannelId: "C_NO_POST_TREE",
      slackThreadTs: "500.1",
      contextKey: noTreeContextKey,
    });
    const supplied = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*No tree yet*" },
      },
    ];

    const result = await tools["slack-post"]!.handler(
      {
        channelId: "C_NO_POST_TREE",
        threadTs: "500.1",
        message: "fallback",
        blocks: supplied,
      },
      meta(leadId, noTreeTask.id),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(mockChatPostMessage.mock.calls[0]![0]).toMatchObject({
      channel: "C_NO_POST_TREE",
      thread_ts: "500.1",
      text: "fallback",
      blocks: supplied,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(mockChatPostMessage.mock.calls[0]![0].blocks).toEqual(supplied);
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
      unfurl_links: false,
      unfurl_media: false,
    });
    expect((await getSlackMessageByChannelTs("C_START", lastPostedTs))?.kind).toBe("agent");
  });

  test("default blocks split a 3,946-char message into sections under Slack's cap", async () => {
    expect(LONG_MESSAGE.length).toBe(3946);
    const tools = buildTools();
    const cases = [
      ["slack-post", { channelId: "C_LONG_POST", message: LONG_MESSAGE }, leadId],
      ["slack-reply", { taskId, message: LONG_MESSAGE }, workerId],
      ["slack-start-thread", { channelId: "C_LONG_START", message: LONG_MESSAGE }, leadId],
    ] as const;

    for (const [name, args, agentId] of cases) {
      mockChatPostMessage.mockClear();
      const result = await tools[name]!.handler(args, meta(agentId));
      expect(result.structuredContent.success).toBe(true);
      const posted = mockChatPostMessage.mock.calls[0]![0] as {
        text: string;
        blocks: PostedBlock[];
      };
      expect(posted.text.length).toBe(3946);
      expectSplitSections(posted);
    }
  });

  test("default blocks keep a 2,931-char message with an emoji at 2,900 in one intact section", async () => {
    // 2,931 UTF-16 units: under Slack's 3,000-char cap, with a surrogate pair
    // straddling the 2,900-char hard-split index.
    const message = `${"x".repeat(2899)}😀${"y".repeat(30)}`;
    expect(message.length).toBe(2931);
    const tools = buildTools();
    const cases = [
      ["slack-post", { channelId: "C_EMOJI_POST", message }, leadId],
      ["slack-reply", { taskId, message }, workerId],
      ["slack-start-thread", { channelId: "C_EMOJI_START", message }, leadId],
    ] as const;

    for (const [name, args, agentId] of cases) {
      mockChatPostMessage.mockClear();
      const result = await tools[name]!.handler(args, meta(agentId));
      expect(result.structuredContent.success).toBe(true);
      const posted = mockChatPostMessage.mock.calls[0]![0] as { blocks: PostedBlock[] };
      const sections = posted.blocks.filter((block) => block.type === "section");
      expect(sections).toEqual([{ type: "section", text: { type: "mrkdwn", text: message } }]);
    }
  });

  test("splitter never cuts a surrogate pair on a hard split", () => {
    const text = `${"x".repeat(2899)}😀${"y".repeat(200)}`;
    const chunks = splitSlackSectionText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      const first = chunk.charCodeAt(0);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(chunk.length).toBeLessThanOrEqual(2900);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("default blocks keep a short message in exactly one section", async () => {
    const tools = buildTools();
    const result = await tools["slack-post"]!.handler(
      { channelId: "C_SHORT", message: "short message" },
      meta(leadId),
    );

    expect(result.structuredContent.success).toBe(true);
    expect(mockChatPostMessage.mock.calls[0]![0].blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "short message" } },
    ]);
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
