import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createWorkflow,
  deleteSwarmConfig,
  getKv,
  getSlackTasksInThread,
  initDb,
  updateWorkflow,
  upsertSwarmConfig,
} from "../be/db";
import { __resetInjectedEnvTracking, loadGlobalConfigsIntoEnv } from "../http/core";
import { invokeToolInProcess, resetBridgeServerForTesting } from "../http/mcp-bridge";
import { handleTasks } from "../http/tasks";
import { reservedNamespaceError } from "../kv-reserved-namespaces";
import { createServer as createMcpServer } from "../server";
import { registerCommandHandler } from "../slack/commands";
import { registerMessageHandler, resetSlackHandlerCachesForTesting } from "../slack/handlers";
import {
  isSlackThreadLeft,
  SLACK_LEFT_THREAD_CONFIRMATION,
  SLACK_LEFT_THREAD_KV_NAMESPACE,
} from "../slack/left-threads";
import { bufferThreadMessage, getBufferMessageCount, instantFlush } from "../slack/thread-buffer";
import { slackContextKey } from "../tasks/context-key";
import { registerSlackLeaveThreadTool } from "../tools/slack-leave-thread";
import type { Agent, AgentTask } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { workflowEventBus } from "../workflows/event-bus";
import { BaseExecutor, type ExecutorResult } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { handleEventTrigger } from "../workflows/triggers";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-slack-leave-thread.sqlite";
const BOT_USER_ID = "U_LEAVE_BOT";
const HUMAN = "U_LEAVE_HUMAN";

const previousEnv = {
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_BLOCK_EXTERNAL_CHANNELS: process.env.SLACK_BLOCK_EXTERNAL_CHANNELS,
  SLACK_LEAVE_THREAD_DISABLE: process.env.SLACK_LEAVE_THREAD_DISABLE,
};

type Handler = (args: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, Handler>();
const commands = new Map<string, Handler>();
const ephemerals: Array<Record<string, unknown>> = [];

const client = {
  auth: { test: async () => ({ user_id: BOT_USER_ID, bot_id: "B_LEAVE_BOT" }) },
  conversations: {
    info: async () => ({ ok: true, channel: {} }),
    replies: async () => ({ ok: true, messages: [] }),
  },
  chat: {
    postMessage: async () => ({ ok: true, ts: "1.1" }),
    postEphemeral: async (args: Record<string, unknown>) => {
      ephemerals.push(args);
      return { ok: true };
    },
  },
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

let lead: Agent;
let worker: Agent;
let otherWorker: Agent;

async function seedThread(channel: string, threadTs: string, opts: { unassigned?: boolean } = {}) {
  // As the Slack handlers create it: only Slack ingress writes slackTriggerMessageTs.
  return createTaskExtended("original ask", {
    agentId: opts.unassigned ? undefined : worker.id,
    source: "slack",
    slackChannelId: channel,
    slackThreadTs: threadTs,
    slackTriggerMessageTs: threadTs,
    slackUserId: HUMAN,
  });
}

/** Counts how many times a workflow node actually runs. */
class RecordingExecutor extends BaseExecutor<
  typeof RecordingExecutor.schema,
  typeof RecordingExecutor.outSchema
> {
  static readonly schema = z.object({ template: z.string().optional() });
  static readonly outSchema = z.object({ sent: z.boolean() });
  static runs = 0;

  readonly type = "notify";
  readonly mode = "instant" as const;
  readonly configSchema = RecordingExecutor.schema;
  readonly outputSchema = RecordingExecutor.outSchema;

  protected async execute(): Promise<ExecutorResult<z.infer<typeof RecordingExecutor.outSchema>>> {
    RecordingExecutor.runs++;
    return { status: "success", output: { sent: true } };
  }
}

let routeServer: Server;
let routeBaseUrl: string;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  process.env.SLACK_RENDER_V2 = "false";
  process.env.ADDITIVE_SLACK = "false";
  process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
  delete process.env.SLACK_LEAVE_THREAD_DISABLE;
  lead = await createAgent({ name: "leave-lead", isLead: true, status: "idle", capabilities: [] });
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
  registerCommandHandler({
    command: (name: string, handler: Handler) => {
      commands.set(name, handler);
    },
  } as never);

  routeServer = createServer(async (req, res) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "test-key" });
    const url = req.url ?? "/";
    const handled = await handleTasks(
      req,
      res,
      url.split("?")[0]?.split("/").filter(Boolean) ?? [],
      new URLSearchParams(url.split("?")[1] ?? ""),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) res.writeHead(404).end();
  });
  routeBaseUrl = `http://127.0.0.1:${await listenOnFreePort(routeServer)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => routeServer.close(() => resolve()));
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
  ephemerals.length = 0;
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
    await buildTool().handler({ channelId: "C_LEAVE_B", threadTs: "1900.0002" }, meta(lead.id));

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

  test("only a lead can leave an arbitrary thread by channelId; KV callers cannot write the state", async () => {
    const tool = buildTool();
    const direct = await tool.handler(
      { channelId: "C_LEAVE_D", threadTs: "2100.0001" },
      meta(worker.id),
    );
    expect(direct.structuredContent.success).toBe(false);
    expect(await isSlackThreadLeft("C_LEAVE_D", "2100.0001")).toBe(false);

    expect(reservedNamespaceError(SLACK_LEFT_THREAD_KV_NAMESPACE)).not.toBeNull();
  });

  test("a non-lead cannot leave a thread through a task with hand-set Slack context", async () => {
    const forged = await createTaskExtended("forged", {
      agentId: worker.id,
      creatorAgentId: worker.id,
      source: "mcp",
      slackChannelId: "C_LEAVE_E",
      slackThreadTs: "2200.0001",
    });
    const tool = buildTool();

    const denied = await tool.handler({ taskId: forged.id }, meta(worker.id));
    expect(denied.structuredContent.success).toBe(false);
    expect(await isSlackThreadLeft("C_LEAVE_E", "2200.0001")).toBe(false);

    const byLead = await tool.handler({ taskId: forged.id }, meta(lead.id));
    expect(byLead.structuredContent.success).toBe(true);
    expect(await isSlackThreadLeft("C_LEAVE_E", "2200.0001")).toBe(true);
  });

  test("a non-lead cannot leave a thread through a task it created over REST with source slack", async () => {
    const channel = "C_FORGED_HTTP";
    const threadTs = "1700000000.000001";
    const res = await fetch(`${routeBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": worker.id },
      body: JSON.stringify({
        task: "forged slack task",
        agentId: worker.id,
        routingReason: "skill",
        source: "slack",
        contextKey: slackContextKey({ channelId: channel, threadTs }),
      }),
    });
    expect(res.status).toBe(201);
    const forged = (await res.json()) as AgentTask;
    expect(forged.source).toBe("slack");
    expect(forged.slackChannelId).toBe(channel);
    expect(forged.slackThreadTs).toBe(threadTs);

    const denied = await buildTool().handler({ taskId: forged.id }, meta(worker.id));
    expect(denied.structuredContent.success).toBe(false);
    expect(await isSlackThreadLeft(channel, threadTs)).toBe(false);
  });

  test("a plain reply in a left thread starts no workflow; a mention still does", async () => {
    const workflow = await createWorkflow({
      name: "leave-thread-slack-listener",
      triggers: [{ type: "event", eventName: "slack.message" }],
      definition: { nodes: [{ id: "n1", type: "notify", config: { template: "ping" } }] },
    });
    const registry = new ExecutorRegistry();
    registry.register(new RecordingExecutor());
    const emitted: unknown[] = [];
    const started: Promise<string[]>[] = [];
    const listener = (payload: unknown) => {
      emitted.push(payload);
      started.push(handleEventTrigger("slack.message", payload, registry));
    };
    workflowEventBus.on("slack.message", listener);
    RecordingExecutor.runs = 0;
    try {
      const task = await seedThread("C_LEAVE_F", "2300.0001");
      await buildTool().handler({ taskId: task.id }, meta(worker.id));

      await sendThreadReply("C_LEAVE_F", "2300.0001", "people talking among themselves");
      const mutedRuns = (await Promise.all(started)).flat();
      expect(emitted).toHaveLength(0);
      expect(mutedRuns).toHaveLength(0);
      expect(RecordingExecutor.runs).toBe(0);

      await sendThreadReply("C_LEAVE_F", "2300.0001", `<@${BOT_USER_ID}> back in`);
      const mentionRuns = (await Promise.all(started)).flat();
      expect(emitted).toHaveLength(1);
      expect(mentionRuns).toHaveLength(1);
      expect(RecordingExecutor.runs).toBe(1);
    } finally {
      workflowEventBus.off("slack.message", listener);
      await updateWorkflow(workflow.id, { enabled: false });
    }
  });

  test("replies buffered before the thread was left create no task when they flush", async () => {
    const task = await seedThread("C_LEAVE_G", "2400.0001");
    bufferThreadMessage("C_LEAVE_G", "2400.0001", "still chatting", HUMAN, "2400.0002");
    await buildTool().handler({ taskId: task.id }, meta(worker.id));

    await instantFlush("C_LEAVE_G:2400.0001");
    expect(await getSlackTasksInThread("C_LEAVE_G", "2400.0001")).toHaveLength(1);
  });
});

describe("SLACK_LEAVE_THREAD_DISABLE", () => {
  function registeredTools(server: McpServer): Record<string, unknown> {
    return (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  }

  test("set at session creation, the tool is absent from the MCP surface", async () => {
    expect(registeredTools(await createMcpServer())["slack-leave-thread"]).toBeDefined();

    process.env.SLACK_LEAVE_THREAD_DISABLE = "true";
    try {
      const tools = registeredTools(await createMcpServer());
      expect(tools["slack-leave-thread"]).toBeUndefined();
      expect(tools["slack-reply"]).toBeDefined();
    } finally {
      delete process.env.SLACK_LEAVE_THREAD_DISABLE;
    }
  });

  // The scripts bridge caches the full-surface server it builds on first use.
  test("the cached scripts bridge follows the flag per call, not the flag at first build", async () => {
    function bridgeLeave(taskId: string) {
      return invokeToolInProcess({
        toolName: "slack-leave-thread",
        args: { taskId },
        agentId: worker.id,
        callOrigin: "script-sdk",
      }) as Promise<{ structuredContent: { success: boolean; message: string } }>;
    }

    resetBridgeServerForTesting();
    process.env.SLACK_LEAVE_THREAD_DISABLE = "true";
    try {
      const refused = await bridgeLeave((await seedThread("C_LEAVE_I", "2600.0001")).id);
      expect(refused.structuredContent.success).toBe(false);
      expect(refused.structuredContent.message).toContain("SLACK_LEAVE_THREAD_DISABLE");

      delete process.env.SLACK_LEAVE_THREAD_DISABLE;
      const left = await bridgeLeave((await seedThread("C_LEAVE_I", "2600.0002")).id);
      expect(left.structuredContent.success).toBe(true);
      expect(await isSlackThreadLeft("C_LEAVE_I", "2600.0002")).toBe(true);
    } finally {
      delete process.env.SLACK_LEAVE_THREAD_DISABLE;
    }

    resetBridgeServerForTesting();
    try {
      expect(
        (await bridgeLeave((await seedThread("C_LEAVE_I", "2600.0003")).id)).structuredContent
          .success,
      ).toBe(true);

      process.env.SLACK_LEAVE_THREAD_DISABLE = "true";
      const refused = await bridgeLeave((await seedThread("C_LEAVE_I", "2600.0004")).id);
      expect(refused.structuredContent.success).toBe(false);
      expect(refused.structuredContent.message).toContain("SLACK_LEAVE_THREAD_DISABLE");
      expect(await isSlackThreadLeft("C_LEAVE_I", "2600.0004")).toBe(false);
    } finally {
      delete process.env.SLACK_LEAVE_THREAD_DISABLE;
      resetBridgeServerForTesting();
    }
  });

  test("set through a global config reload after registration, the call fails naming the flag", async () => {
    const task = await seedThread("C_LEAVE_H", "2500.0001");
    const tool = buildTool();
    const row = await upsertSwarmConfig({
      scope: "global",
      key: "SLACK_LEAVE_THREAD_DISABLE",
      value: "true",
    });
    try {
      await loadGlobalConfigsIntoEnv(true);
      const refused = await tool.handler({ taskId: task.id }, meta(worker.id));
      expect(refused.structuredContent.success).toBe(false);
      expect(refused.structuredContent.message).toContain("SLACK_LEAVE_THREAD_DISABLE");
      expect(await isSlackThreadLeft("C_LEAVE_H", "2500.0001")).toBe(false);

      await deleteSwarmConfig(row.id);
      await loadGlobalConfigsIntoEnv(true);
      const left = await tool.handler({ taskId: task.id }, meta(worker.id));
      expect(left.structuredContent.success).toBe(true);
      expect(await isSlackThreadLeft("C_LEAVE_H", "2500.0001")).toBe(true);
    } finally {
      await deleteSwarmConfig(row.id);
      __resetInjectedEnvTracking();
      delete process.env.SLACK_LEAVE_THREAD_DISABLE;
    }
  });
});

describe("!leave", () => {
  test("leaves the thread in code: no task, no workflow event, an ephemeral confirmation", async () => {
    const emitted: unknown[] = [];
    const listener = (payload: unknown) => emitted.push(payload);
    workflowEventBus.on("slack.message", listener);
    try {
      await seedThread("C_BANG_A", "3000.0001");
      expect(await sendThreadReply("C_BANG_A", "3000.0001", "!leave")).toHaveLength(1);
      expect(emitted).toHaveLength(0);
    } finally {
      workflowEventBus.off("slack.message", listener);
    }

    expect(await isSlackThreadLeft("C_BANG_A", "3000.0001")).toBe(true);
    const entry = await getKv(SLACK_LEFT_THREAD_KV_NAMESPACE, "C_BANG_A:3000.0001");
    expect(entry?.value).toMatchObject({ slackUserId: HUMAN });
    expect(entry?.value).not.toHaveProperty("agentId");
    expect(ephemerals).toEqual([
      {
        channel: "C_BANG_A",
        user: HUMAN,
        thread_ts: "3000.0001",
        text: SLACK_LEFT_THREAD_CONFIRMATION,
      },
    ]);

    expect(await sendThreadReply("C_BANG_A", "3000.0001", "chatting among ourselves")).toHaveLength(
      1,
    );
    expect(
      await sendThreadReply("C_BANG_A", "3000.0001", `<@${BOT_USER_ID}> back please`),
    ).toHaveLength(2);
    expect(await isSlackThreadLeft("C_BANG_A", "3000.0001")).toBe(false);
  });

  test("an @mention before !leave leaves instead of rejoining, also in a left thread", async () => {
    await seedThread("C_BANG_B", "3100.0001");
    await sendThreadReply("C_BANG_B", "3100.0001", "!leave");
    expect(await sendThreadReply("C_BANG_B", "3100.0001", `<@${BOT_USER_ID}> !leave`)).toHaveLength(
      1,
    );
    expect(await isSlackThreadLeft("C_BANG_B", "3100.0001")).toBe(true);
    expect(ephemerals).toHaveLength(2);
  });

  test("with ADDITIVE_SLACK the !leave message is never buffered", async () => {
    process.env.ADDITIVE_SLACK = "true";
    try {
      await seedThread("C_BANG_C", "3200.0001");
      await sendThreadReply("C_BANG_C", "3200.0001", "!leave");
      expect(getBufferMessageCount("C_BANG_C:3200.0001")).toBe(0);
      expect(await isSlackThreadLeft("C_BANG_C", "3200.0001")).toBe(true);
    } finally {
      process.env.ADDITIVE_SLACK = "false";
    }
  });

  test.each([
    ["!leave", "3600.0001"],
    [`<@${BOT_USER_ID}> !leave`, "3600.0002"],
  ])("leaves a human-rooted thread whose only task is unassigned: %s", async (text, threadTs) => {
    const emitted: unknown[] = [];
    const listener = (payload: unknown) => emitted.push(payload);
    workflowEventBus.on("slack.message", listener);
    try {
      const seeded = await seedThread("C_BANG_G", threadTs, { unassigned: true });
      expect(seeded.agentId).toBeNull();
      expect(await sendThreadReply("C_BANG_G", threadTs, text)).toHaveLength(1);
      expect(emitted).toHaveLength(0);
    } finally {
      workflowEventBus.off("slack.message", listener);
    }
    expect(await isSlackThreadLeft("C_BANG_G", threadTs)).toBe(true);
    expect(ephemerals).toHaveLength(1);
  });

  test("a task in another thread of the channel does not make !leave a command", async () => {
    await seedThread("C_BANG_H", "3700.0001", { unassigned: true });
    await sendThreadReply("C_BANG_H", "3700.0002", "!leave");
    expect(await isSlackThreadLeft("C_BANG_H", "3700.0002")).toBe(false);
    expect(ephemerals).toHaveLength(0);
  });

  test("is not a command outside a swarm thread, when addressed elsewhere, or with extra text", async () => {
    await sendThreadReply("C_BANG_D", "3300.0001", "!leave");
    expect(await isSlackThreadLeft("C_BANG_D", "3300.0001")).toBe(false);

    await seedThread("C_BANG_E", "3400.0001");
    await sendThreadReply("C_BANG_E", "3400.0001", "<@U_SOMEONE_ELSE> !leave");
    await sendThreadReply("C_BANG_E", "3400.0001", "!leave it to me");
    expect(await isSlackThreadLeft("C_BANG_E", "3400.0001")).toBe(false);
    expect(ephemerals).toHaveLength(0);
  });

  test("SLACK_LEAVE_THREAD_DISABLE makes !leave an ordinary message and hides it from help", async () => {
    async function helpText(): Promise<string> {
      let text = "";
      await commands.get("/agent-swarm-help")!({
        ack: async () => {},
        respond: async (reply: { blocks: Array<{ text: { text: string } }> }) => {
          text = reply.blocks.map((b) => b.text.text).join("\n");
        },
      });
      return text;
    }
    expect(await helpText()).toContain("`!leave` in a thread");

    process.env.SLACK_LEAVE_THREAD_DISABLE = "true";
    try {
      await seedThread("C_BANG_F", "3500.0001");
      expect(await sendThreadReply("C_BANG_F", "3500.0001", "!leave")).toHaveLength(2);
      expect(await isSlackThreadLeft("C_BANG_F", "3500.0001")).toBe(false);
      expect(ephemerals).toHaveLength(0);
      expect(await helpText()).not.toContain("!leave");
    } finally {
      delete process.env.SLACK_LEAVE_THREAD_DISABLE;
    }
  });
});
