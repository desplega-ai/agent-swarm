import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createTaskExtended, getKv, initDb } from "../be/db";
import { CHAT_CHANNELS_NAMESPACE } from "../integrations/chat-sdk/router";
import { createServer } from "../server";
import { chatSdkContextKey } from "../tasks/context-key";
import { registerChatReplyTool } from "../tools/chat-reply";
import {
  registerRegisterChatChannelTool,
  registerUnregisterChatChannelTool,
} from "../tools/register-chat-channel";
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
  registerRegisterChatChannelTool(server);
  registerUnregisterChatChannelTool(server);
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
