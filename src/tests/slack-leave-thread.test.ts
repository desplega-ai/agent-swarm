import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createTaskExtended, getSlackTasksInThread, initDb } from "../be/db";
import { registerMessageHandler, resetSlackHandlerCachesForTesting } from "../slack/handlers";
import { isSlackThreadLeft } from "../slack/left-threads";
import { registerSlackLeaveThreadTool } from "../tools/slack-leave-thread";
import type { Agent } from "../types";

const TEST_DB_PATH = "./test-slack-leave-thread.sqlite";
const BOT_USER_ID = "U_LEAVE_BOT";
const HUMAN = "U_LEAVE_HUMAN";

const previousEnv = {
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_BLOCK_EXTERNAL_CHANNELS: process.env.SLACK_BLOCK_EXTERNAL_CHANNELS,
};

type Handler = (args: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, Handler>();

const client = {
  auth: { test: async () => ({ user_id: BOT_USER_ID, bot_id: "B_LEAVE_BOT" }) },
  conversations: {
    info: async () => ({ ok: true, channel: {} }),
    replies: async () => ({ ok: true, messages: [] }),
  },
  chat: { postMessage: async () => ({ ok: true, ts: "1.1" }) },
  reactions: { add: async () => ({ ok: true }) },
  users: { info: async () => ({ ok: true, user: { profile: {} } }) },
};

type RegisteredTool = {
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ structuredContent: { success: boolean; message: string } }>;
};

function buildTool(): RegisteredTool {
  const server = new McpServer({ name: "slack-leave-thread-test", version: "1.0.0" });
  registerSlackLeaveThreadTool(server);
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools["slack-leave-thread"];
  if (!tool) throw new Error("slack-leave-thread tool not registered");
  return tool;
}

function meta(agentId: string) {
  return { sessionId: "s1", requestInfo: { headers: { "x-agent-id": agentId } } };
}

let counter = 0;
async function sendThreadReply(channel: string, threadTs: string, text: string) {
  counter++;
  await handlers.get("message")!({
    event: {
      channel,
      ts: `18000.${String(counter).padStart(4, "0")}`,
      thread_ts: threadTs,
      text,
      user: HUMAN,
    },
    body: { event_id: `evt_leave_${counter}` },
    client,
    say: async () => ({ ok: true, ts: "1.2" }),
  });
  return getSlackTasksInThread(channel, threadTs);
}

let worker: Agent;
let otherWorker: Agent;

async function seedThread(channel: string, threadTs: string) {
  return createTaskExtended("original ask", {
    agentId: worker.id,
    source: "slack",
    slackChannelId: channel,
    slackThreadTs: threadTs,
    slackUserId: HUMAN,
  });
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  process.env.SLACK_RENDER_V2 = "false";
  process.env.ADDITIVE_SLACK = "false";
  process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
  await createAgent({ name: "leave-lead", isLead: true, status: "idle", capabilities: [] });
  worker = await createAgent({
    name: "leave-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
  otherWorker = await createAgent({
    name: "leave-other",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
  registerMessageHandler({
    event: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
  } as never);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  resetSlackHandlerCachesForTesting();
});

describe("slack-leave-thread", () => {
  test("a left thread skips a plain reply; a mention clears the state and is processed", async () => {
    const task = await seedThread("C_LEAVE_A", "1800.0001");
    const result = await buildTool().handler({ taskId: task.id }, meta(worker.id));
    expect(result.structuredContent.success).toBe(true);
    expect(await isSlackThreadLeft("C_LEAVE_A", "1800.0001")).toBe(true);

    expect(await sendThreadReply("C_LEAVE_A", "1800.0001", "thanks, we'll sort it")).toHaveLength(
      1,
    );

    const afterMention = await sendThreadReply(
      "C_LEAVE_A",
      "1800.0001",
      `<@${BOT_USER_ID}> one more thing`,
    );
    expect(afterMention).toHaveLength(2);
    expect(await isSlackThreadLeft("C_LEAVE_A", "1800.0001")).toBe(false);

    // Back in the thread: plain replies follow up again.
    expect(await sendThreadReply("C_LEAVE_A", "1800.0001", "and also this")).toHaveLength(3);
  });

  test("another thread is unaffected", async () => {
    await seedThread("C_LEAVE_B", "1900.0001");
    await buildTool().handler({ channelId: "C_LEAVE_B", threadTs: "1900.0002" }, meta(worker.id));

    expect(await isSlackThreadLeft("C_LEAVE_B", "1900.0002")).toBe(true);
    expect(await sendThreadReply("C_LEAVE_B", "1900.0001", "plain follow-up")).toHaveLength(2);
  });

  test("refuses a task the agent has no context for, and missing arguments", async () => {
    const task = await seedThread("C_LEAVE_C", "2000.0001");
    const tool = buildTool();

    const foreign = await tool.handler({ taskId: task.id }, meta(otherWorker.id));
    expect(foreign.structuredContent.success).toBe(false);
    expect(await isSlackThreadLeft("C_LEAVE_C", "2000.0001")).toBe(false);

    const missing = await tool.handler({ channelId: "C_LEAVE_C" }, meta(worker.id));
    expect(missing.structuredContent.success).toBe(false);
  });
});
