import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  getDbClient,
  getKv,
  getScheduledTaskById,
  getTaskById,
  initDb,
} from "../be/db";
import { CHAT_CHANNELS_NAMESPACE } from "../integrations/chat-sdk/router";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { createServer } from "../server";
import { chatSdkContextKey } from "../tasks/context-key";
import { registerChatOpenDmTool } from "../tools/chat-open-dm";
import { registerChatPostTool } from "../tools/chat-post";
import { registerChatReadThreadTool } from "../tools/chat-read-thread";
import { registerChatReplyTool } from "../tools/chat-reply";
import {
  registerRegisterChatChannelTool,
  registerUnregisterChatChannelTool,
} from "../tools/register-chat-channel";
import { registerPatchScheduleTool } from "../tools/schedules/patch-schedule";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";
import { registerSendTaskTool } from "../tools/send-task";
import type { Agent } from "../types";
import { startTelegramHarness, type TelegramHarness } from "./chat-sdk-harness";

const TEST_DB_PATH = "./test-chat-sdk-tools.sqlite";
const CHAT_TOOLS = [
  "chat-open-dm",
  "chat-post",
  "chat-read-thread",
  "chat-reply",
  "register-chat-channel",
  "unregister-chat-channel",
];
const ENV_KEYS = ["CHAT_SDK_ENABLED", "CAPABILITIES", "SWARM_ENABLED_TOOLS"];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let lead: Agent;
let worker: Agent;
let server: McpServer;

type ToolResult = {
  isError?: boolean;
  structuredContent: { success: boolean; message: string; [key: string]: unknown };
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function chatToolNames(opts: Parameters<typeof createServer>[0] = {}): Promise<string[]> {
  const created = (await createServer(opts)) as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(created._registeredTools)
    .filter((name) => CHAT_TOOLS.includes(name))
    .sort();
}

async function callTool(
  name: string,
  headers: Record<string, string>,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  return (await handler(args, {
    sessionId: "test-session",
    requestInfo: { headers },
  })) as ToolResult;
}

beforeAll(async () => {
  await removeDbFiles();
  for (const key of ENV_KEYS) delete process.env[key];
  initDb(TEST_DB_PATH);
  lead = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatToolsLead",
    isLead: true,
    status: "idle",
  });
  worker = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatToolsWorker",
    isLead: false,
    status: "idle",
  });
  server = new McpServer({ name: "chat-tools-test", version: "1.0.0" });
  registerChatReplyTool(server);
  registerChatPostTool(server);
  registerChatOpenDmTool(server);
  registerChatReadThreadTool(server);
  registerRegisterChatChannelTool(server);
  registerUnregisterChatChannelTool(server);
  registerSendTaskTool(server);
  registerPatchScheduleTool(server);
  registerUpdateScheduleTool(server);
});

afterAll(async () => {
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("chat-sdk tool registration", () => {
  test("the six tools register only when CHAT_SDK_ENABLED is true", async () => {
    try {
      delete process.env.CHAT_SDK_ENABLED;
      expect(await chatToolNames()).toEqual([]);

      // The CAPABILITIES list alone does not switch the channel on.
      process.env.CAPABILITIES = "core,chat-sdk";
      expect(await chatToolNames()).toEqual([]);
      delete process.env.CAPABILITIES;

      process.env.CHAT_SDK_ENABLED = "true";
      expect(await chatToolNames()).toEqual(CHAT_TOOLS);
      // A session bound to a non-chat task drops chat-reply.
      expect(await chatToolNames({ excludedTools: ["chat-reply"] })).toEqual(
        CHAT_TOOLS.filter((name) => name !== "chat-reply"),
      );
      delete process.env.CHAT_SDK_ENABLED;
    } finally {
      restoreEnv();
    }
  });

  test("the full surface (scripts bridge) always has them", async () => {
    delete process.env.CHAT_SDK_ENABLED;
    expect(await chatToolNames({ fullSurface: true })).toEqual(CHAT_TOOLS);
  });
});

describe("chat-reply", () => {
  let harness: TelegramHarness;

  beforeAll(async () => {
    harness = await startTelegramHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("refuses a task without a chat-sdk contextKey", async () => {
    const task = await createTaskExtended("not a chat task", {
      agentId: worker.id,
      source: "mcp",
    });
    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "hello" },
    );
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("did not come from a chat thread");
  });

  test("refuses another agent's task", async () => {
    const task = await createTaskExtended("someone else's chat task", {
      agentId: lead.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:991001"),
    });
    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "hello" },
    );
    expect(result.structuredContent.success).toBe(false);
    expect(
      harness.mock.calls.some(
        (call) => String((call.body as { chat_id?: unknown }).chat_id) === "991001",
      ),
    ).toBe(false);
  });

  test("posts to the thread of a chat task", async () => {
    const task = await createTaskExtended("a chat task", {
      agentId: worker.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:991002"),
      mentionMessageId: "991002:77",
      mentionChannelId: "telegram:991002",
    });
    const result = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { text: "Which branch should I use?" },
    );
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent).toMatchObject({
      adapter: "telegram",
      threadId: "telegram:991002",
    });
    expect(typeof result.structuredContent.messageId).toBe("string");
    const sends = harness.mock.calls.filter(
      (call) =>
        /^send(Rich)?Message$/.test(call.method) &&
        String((call.body as { chat_id?: unknown }).chat_id) === "991002",
    );
    expect(sends).toHaveLength(1);
    // Anchored like the final answer: a reply to the message that started the task.
    expect(sends[0]?.body.reply_parameters).toEqual({
      message_id: 77,
      allow_sending_without_reply: true,
    });
  });
});

describe("register-chat-channel", () => {
  test("is refused for a non-lead agent", async () => {
    const result = await callTool(
      "register-chat-channel",
      { "x-agent-id": worker.id },
      { adapter: "telegram", channelId: "telegram:-100555", agentId: worker.id },
    );
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("Permission denied");
    expect(await getKv(CHAT_CHANNELS_NAMESPACE, "telegram:-100555")).toBeNull();

    const unregister = await callTool(
      "unregister-chat-channel",
      { "x-agent-id": worker.id },
      { adapter: "telegram", channelId: "telegram:-100555" },
    );
    expect(unregister.structuredContent.message).toContain("Permission denied");
  });

  test("a lead writes and removes the mapping under chatChannelKey", async () => {
    const both = await callTool(
      "register-chat-channel",
      { "x-agent-id": lead.id },
      { adapter: "telegram", channelId: "-100556", agentId: worker.id, workflowId: "w" },
    );
    expect(both.structuredContent.success).toBe(false);

    // A bare platform id gets the adapter prefix; a prefixed id is kept.
    const result = await callTool(
      "register-chat-channel",
      { "x-agent-id": lead.id },
      { adapter: "telegram", channelId: "-100556", agentId: worker.id, name: "ops" },
    );
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.key).toBe("telegram:-100556");
    const stored = await getKv(CHAT_CHANNELS_NAMESPACE, "telegram:-100556");
    expect(stored?.value).toMatchObject({ agentId: worker.id, name: "ops" });

    const removed = await callTool(
      "unregister-chat-channel",
      { "x-agent-id": lead.id },
      { adapter: "telegram", channelId: "telegram:-100556" },
    );
    expect(removed.structuredContent.success).toBe(true);
    expect(await getKv(CHAT_CHANNELS_NAMESPACE, "telegram:-100556")).toBeNull();
  });
});

describe("chat tool permissions", () => {
  let harness: TelegramHarness;

  beforeAll(async () => {
    harness = await startTelegramHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  const sendsTo = (chatId: string) =>
    harness.mock.calls.filter(
      (call) =>
        /^send(Rich)?Message$/.test(call.method) &&
        String((call.body as { chat_id?: unknown }).chat_id) === chatId,
    );

  test("chat-post is refused for a worker and sends nothing", async () => {
    const result = await callTool(
      "chat-post",
      { "x-agent-id": worker.id },
      { adapter: "telegram", threadId: "telegram:991010", text: "hello" },
    );
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("Permission denied");
    expect(sendsTo("991010")).toHaveLength(0);
  });

  test("chat-post lets the lead post to any thread", async () => {
    const result = await callTool(
      "chat-post",
      { "x-agent-id": lead.id },
      { adapter: "telegram", threadId: "telegram:991010", text: "hello" },
    );
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.threadId).toBe("telegram:991010");
    expect(sendsTo("991010")).toHaveLength(1);
  });

  test("chat-open-dm is refused for a worker and allowed for the lead", async () => {
    const refused = await callTool(
      "chat-open-dm",
      { "x-agent-id": worker.id },
      { adapter: "telegram", userId: "991011" },
    );
    expect(refused.structuredContent.success).toBe(false);
    expect(refused.structuredContent.message).toContain("Permission denied");

    const opened = await callTool(
      "chat-open-dm",
      { "x-agent-id": lead.id },
      { adapter: "telegram", userId: "991011" },
    );
    expect(opened.structuredContent.success).toBe(true);
    expect(opened.structuredContent.threadId).toBe("telegram:991011");
  });

  test("chat-read-thread: a worker reads its task thread, not another one", async () => {
    const task = await createTaskExtended("worker chat task", {
      agentId: worker.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:991012"),
    });
    const own = await callTool(
      "chat-read-thread",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { threadId: "telegram:991012" },
    );
    expect(own.structuredContent.success).toBe(true);
    expect(own.structuredContent.threadId).toBe("telegram:991012");

    const other = await callTool(
      "chat-read-thread",
      { "x-agent-id": worker.id, "x-source-task-id": task.id },
      { threadId: "telegram:991013" },
    );
    expect(other.structuredContent.success).toBe(false);
    expect(other.structuredContent.message).toContain("Permission denied");
    expect(other.structuredContent.message).toContain("telegram:991012");

    // Without a task binding at all, a worker gets nothing.
    const noTask = await callTool(
      "chat-read-thread",
      { "x-agent-id": worker.id },
      { threadId: "telegram:991013" },
    );
    expect(noTask.structuredContent.success).toBe(false);
    expect(noTask.structuredContent.message).toContain("Permission denied");
  });

  test("chat-read-thread lets the lead read any thread", async () => {
    const result = await callTool(
      "chat-read-thread",
      { "x-agent-id": lead.id },
      { threadId: "telegram:991013" },
    );
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.threadId).toBe("telegram:991013");
  });
});

describe("chat thread binding through send-task", () => {
  let harness: TelegramHarness;

  beforeAll(async () => {
    harness = await startTelegramHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  const sendsTo = (chatId: string) =>
    harness.mock.calls.filter(
      (call) =>
        /^send(Rich)?Message$/.test(call.method) &&
        String((call.body as { chat_id?: unknown }).chat_id) === chatId,
    );

  const childrenOf = async (parentId: string) =>
    await getDbClient().query<{ id: string }>("SELECT id FROM agent_tasks WHERE parentTaskId = ?", [
      parentId,
    ]);

  test("a worker cannot create a child under a foreign chat task, so it gains no thread access", async () => {
    const own = await createTaskExtended("worker chat task A", {
      agentId: worker.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:111111"),
    });
    const foreign = await createTaskExtended("lead chat task B", {
      agentId: lead.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:222222"),
    });

    // An explicit foreign parentTaskId, routed to the parent's assignee or offered to the
    // worker itself, and a foreign X-Source-Task-ID as the implicit parent: all refused.
    const attempts: Array<{ headers: Record<string, string>; args: Record<string, unknown> }> = [
      {
        headers: { "x-agent-id": worker.id, "x-source-task-id": own.id },
        args: { task: "child under B", parentTaskId: foreign.id, allowDuplicate: true },
      },
      {
        headers: { "x-agent-id": worker.id, "x-source-task-id": own.id },
        args: {
          task: "child under B offered to me",
          parentTaskId: foreign.id,
          offerMode: true,
          allowDuplicate: true,
        },
      },
      {
        headers: { "x-agent-id": worker.id, "x-source-task-id": foreign.id },
        args: { task: "child under the header task", allowDuplicate: true },
      },
    ];
    for (const { headers, args } of attempts) {
      const result = await callTool("send-task", headers, args);
      expect(result.structuredContent.success, String(args.task)).toBe(false);
      expect(result.structuredContent.message).toContain(
        `You don't have context for parent task ${foreign.id}`,
      );
    }
    expect(await childrenOf(foreign.id)).toHaveLength(0);

    // Without a manufactured child, the worker's only binding is its own thread.
    const read = await callTool(
      "chat-read-thread",
      { "x-agent-id": worker.id, "x-source-task-id": own.id },
      { threadId: "telegram:222222" },
    );
    expect(read.structuredContent.success).toBe(false);
    expect(read.structuredContent.message).toContain("Permission denied");
    const reply = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": foreign.id },
      { text: "hijack" },
    );
    expect(reply.structuredContent.success).toBe(false);
    expect(sendsTo("222222")).toHaveLength(0);
  });

  test("the lead delegates its chat task, and the assigned worker replies in that thread", async () => {
    const delegate = await createAgent({
      id: crypto.randomUUID(),
      name: "ChatToolsDelegate",
      isLead: false,
      status: "idle",
      maxTasks: 5,
    });
    const parent = await createTaskExtended("lead chat task", {
      agentId: lead.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:333333"),
    });

    const sent = await callTool(
      "send-task",
      { "x-agent-id": lead.id, "x-source-task-id": parent.id },
      {
        task: "do the chat work",
        agentId: delegate.id,
        routingReason: "skill",
        routingNote: "Delegate owns this kind of chat work.",
        allowDuplicate: true,
      },
    );
    expect(sent.structuredContent.success).toBe(true);
    const childId = (sent.structuredContent.task as { id: string }).id;
    const child = await getTaskById(childId);
    expect(child?.parentTaskId).toBe(parent.id);
    expect(child?.contextKey).toBe(chatSdkContextKey("telegram:333333"));

    const reply = await callTool(
      "chat-reply",
      { "x-agent-id": delegate.id, "x-source-task-id": childId },
      { text: "Working on it." },
    );
    expect(reply.structuredContent.success).toBe(true);
    expect(reply.structuredContent.threadId).toBe("telegram:333333");
    expect(sendsTo("333333")).toHaveLength(1);
  });

  test("a worker sub-delegates under its own chat task", async () => {
    const helper = await createAgent({
      id: crypto.randomUUID(),
      name: "ChatToolsHelper",
      isLead: false,
      status: "idle",
      maxTasks: 5,
    });
    const own = await createTaskExtended("worker chat task to split", {
      agentId: worker.id,
      source: "chat",
      contextKey: chatSdkContextKey("telegram:444444"),
    });
    const sent = await callTool(
      "send-task",
      { "x-agent-id": worker.id, "x-source-task-id": own.id },
      {
        task: "do half of the chat work",
        agentId: helper.id,
        routingReason: "skill",
        routingNote: "Helper takes the second half of the work.",
        allowDuplicate: true,
      },
    );
    expect(sent.structuredContent.success).toBe(true);
    const child = await getTaskById((sent.structuredContent.task as { id: string }).id);
    expect(child?.parentTaskId).toBe(own.id);
    expect(child?.contextKey).toBe(chatSdkContextKey("telegram:444444"));
  });
});

describe("defer-task wake-ups and chat thread access", () => {
  let harness: TelegramHarness;

  beforeAll(async () => {
    harness = await startTelegramHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  /** A lead chat task deferred with defer-task: the task is done, its wake-up booked. */
  async function leadDeferral(chatId: string) {
    const parent = await createTaskExtended("human ask", {
      agentId: lead.id,
      source: "chat",
      contextKey: chatSdkContextKey(`telegram:${chatId}`),
      mentionMessageId: `${chatId}:55`,
    });
    await completeTask(parent.id, "Deferred.", { deferredAt: new Date().toISOString() });
    const schedule = await createScheduledTask({
      name: `deferred-${parent.id.slice(0, 8)}-${crypto.randomUUID()}`,
      taskTemplate: "finish the original ask",
      targetType: "agent-task",
      scheduleType: "one_time",
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      targetAgentId: lead.id,
      createdByAgentId: lead.id,
      taskType: "deferred",
      parentTaskId: parent.id,
    });
    return { parent, schedule };
  }

  test("another worker cannot change a lead's deferral", async () => {
    const { schedule } = await leadDeferral("992881");
    for (const tool of ["patch-schedule", "update-schedule"]) {
      const result = await callTool(
        tool,
        { "x-agent-id": worker.id },
        { scheduleId: schedule.id, targetAgentId: worker.id, taskTemplate: "emit ATTACKER OUTPUT" },
      );
      expect(result.structuredContent.success).toBe(false);
    }
    const after = await getScheduledTaskById(schedule.id);
    expect(after?.targetAgentId).toBe(lead.id);
    expect(after?.taskTemplate).toBe("finish the original ask");
  });

  test("a deferral re-targeted to another agent wakes up outside the chat thread", async () => {
    const chatId = "992882";
    const { schedule } = await leadDeferral(chatId);
    // A lead may re-target it; the new assignee still gets no thread access.
    const patched = await callTool(
      "patch-schedule",
      { "x-agent-id": lead.id },
      { scheduleId: schedule.id, targetAgentId: worker.id },
    );
    expect(patched.structuredContent.success).toBe(true);
    const retargeted = await getScheduledTaskById(schedule.id);
    if (!retargeted) throw new Error("schedule vanished");

    const wakeUp = await createStandaloneScheduleTask(retargeted);
    expect(wakeUp.agentId).toBe(worker.id);
    expect(wakeUp.contextKey).toBe(`task:schedule:${schedule.id}`);

    const reply = await callTool(
      "chat-reply",
      { "x-agent-id": worker.id, "x-source-task-id": wakeUp.id },
      { text: "ATTACKER DIRECT REPLY" },
    );
    expect(reply.structuredContent.success).toBe(false);

    await completeTask(wakeUp.id, "ATTACKER OUTPUT");
    const obligation = await getDbClient().get(
      "SELECT task_id FROM chat_relay_obligations WHERE task_id = ?",
      [wakeUp.id],
    );
    expect(obligation).toBeNull();
    expect(
      harness.mock.calls.some(
        (call) =>
          /^send(Rich)?Message$/.test(call.method) &&
          String((call.body as { chat_id?: unknown }).chat_id) === chatId,
      ),
    ).toBe(false);
  });
});
