import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, getLatestActiveTaskInThread, initDb } from "../be/db";

process.env.SLACK_RENDER_V2 = "false";
process.env.STEERING_ENABLED = "false";

const TEST_DB_PATH = "./test-slack-thread-buffer-context.sqlite";

// Replies Slack returns for the thread: the root, one earlier human reply, and
// the buffered follow-up itself (conversations.replies includes it by the time
// the buffer flushes).
const threadMessages = [
  { ts: "7000.0001", user: "U0ROOT", text: "original request" },
  { ts: "7000.0005", user: "U0EARLIER", text: "earlier reply that is only context" },
  {
    ts: "7000.0010",
    user: "U0FOLLOWUP",
    text: "please also fix the retry\nand add a test for it",
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: "please also fix the retry\nand add a test for it" }],
          },
        ],
      },
    ],
  },
];

const realSlackApp = await import("../slack/app");
mock.module("../slack/app", () => ({
  ...realSlackApp,
  getSlackApp: () => ({
    client: {
      conversations: { replies: async () => ({ ok: true, messages: threadMessages }) },
      users: { info: async () => ({ ok: true, user: { profile: {} } }) },
      chat: { postMessage: async () => ({ ok: true, ts: "7000.0099" }) },
    },
  }),
}));

const { instantFlush, bufferThreadMessage } = await import("../slack/thread-buffer");

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  await createAgent({ name: "lead-agent", isLead: true, status: "idle", capabilities: [] });
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("buffered follow-up task description", () => {
  test("carries each buffered message once, outside <thread_context>", async () => {
    const channelId = "C700";
    const threadTs = "7000.0001";
    bufferThreadMessage(
      channelId,
      threadTs,
      "please also fix the retry\nand add a test for it",
      "U0FOLLOWUP",
      "7000.0010",
    );

    await instantFlush(`${channelId}:${threadTs}`);

    const task = await getLatestActiveTaskInThread(channelId, threadTs);
    expect(task).not.toBeNull();
    const description = task!.task;
    const context = description.slice(
      description.indexOf("<thread_context>"),
      description.indexOf("</thread_context>"),
    );

    // The follow-up appears exactly once, in the buffered section.
    expect(description.split("please also fix the retry").length - 1).toBe(1);
    expect(context).not.toContain("please also fix the retry");
    expect(description).toContain("1 message(s) buffered");

    // Negative control: messages that are not buffered stay in the context.
    expect(context).toContain("original request");
    expect(context).toContain("earlier reply that is only context");
  });
});
