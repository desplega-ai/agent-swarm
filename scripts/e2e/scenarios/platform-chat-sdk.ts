import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import { listedMcpTools } from "../mcp";
import type { Scenario } from "../run";
import {
  callTool,
  deleteConfig,
  expectToolError,
  expectToolOk,
  putConfig,
  registerAgent,
  reloadConfig,
} from "./platform-helpers";

const CHAT_TOOLS = [
  "chat-open-dm",
  "chat-post",
  "chat-read-thread",
  "chat-reply",
  "register-chat-channel",
  "unregister-chat-channel",
];

export const platformChatSdk: Scenario = {
  name: "platform-chat-sdk",
  order: 651,
  async run(ctx) {
    expect(
      CHAT_TOOLS.every((name) => listedMcpTools().has(name)),
      "The initial tool universe must include all six Chat SDK tools",
    );
    const workerId = await registerAgent(ctx, "chat-worker");
    const leadId = await registerAgent(ctx, "chat-lead", { lead: true });
    const worker = await ctx.connectMcp(workerId);
    const lead = await ctx.connectMcp(leadId);
    const channelId = `-${Number.parseInt(ctx.nonce.slice(0, 8), 16)}`;
    const threadId = `telegram:${channelId}`;
    const key = threadId;
    const mappingRow = () =>
      ctx.db.get<{ value: string }>(
        "SELECT value FROM kv_entries WHERE namespace = ? AND key = ?",
        ["integrations:chat:channels", key],
      );
    let configId: string | undefined;
    let taskId: string | undefined;
    let taskConnection: Awaited<ReturnType<typeof ctx.connectMcp>> | undefined;
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const origin = asString(
      asRecord(JSON.parse(ctx.sutEnv.CHAT_SDK_API_URL_OVERRIDES ?? "{}")).telegram,
      "Telegram mock origin",
    );
    let messageId = 1000;
    const bot = { id: 4242, is_bot: true, first_name: "Swarm", username: "swarm_e2e_bot" };
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(origin).port),
      async fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        const body = asRecord(await request.json());
        calls.push({ method, body });
        if (method === "getMe") return Response.json({ ok: true, result: bot });
        if (method === "getWebhookInfo") {
          return Response.json({ ok: true, result: { url: "" } });
        }
        if (method === "sendMessage" || method === "sendRichMessage") {
          return Response.json({
            ok: true,
            result: {
              message_id: ++messageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: body.chat_id, type: "private" },
              from: bot,
              text: body.text ?? asRecord(body.rich_message).markdown,
            },
          });
        }
        if (["setMyCommands", "deleteWebhook"].includes(method)) {
          return Response.json({ ok: true, result: true });
        }
        return Response.json(
          { ok: false, description: `Unexpected method ${method}` },
          { status: 400 },
        );
      },
    });
    try {
      const names = new Set((await worker.listTools()).map((tool) => tool.name));
      expect(
        CHAT_TOOLS.every((name) => names.has(name)),
        "Workers discover all Chat SDK tools",
      );

      for (const [name, args] of [
        ["chat-post", { adapter: "telegram", threadId, text: ctx.nonce }],
        ["chat-open-dm", { adapter: "telegram", userId: "991001" }],
        ["chat-read-thread", { threadId }],
        ["register-chat-channel", { adapter: "telegram", channelId, agentId: workerId }],
        ["unregister-chat-channel", { adapter: "telegram", channelId }],
      ] as const) {
        expectToolError(await callTool(worker, name, args), name, "Permission denied");
      }
      expect(!mappingRow(), "A worker cannot persist a channel mapping");
      expectToolError(
        await callTool(worker, "chat-reply", { text: ctx.nonce }),
        "reply without task",
        "No current task",
      );

      for (const [name, args] of [
        ["chat-post", { adapter: "telegram", threadId, text: ctx.nonce }],
        ["chat-open-dm", { adapter: "telegram", userId: "991001" }],
        ["chat-read-thread", { threadId }],
      ] as const) {
        expectToolError(await callTool(lead, name, args), name, "not running");
      }
      expect(calls.length === 0, "Disabled adapters make no platform requests");
      expectToolError(
        await callTool(lead, "chat-post", { adapter: "telegram", text: ctx.nonce }),
        "post without target",
        "Give a threadId",
      );
      expectToolError(
        await callTool(lead, "chat-post", { adapter: "slack", threadId, text: ctx.nonce }),
        "adapter mismatch",
        "does not belong",
      );
      for (const args of [{}, { agentId: workerId, workflowId: crypto.randomUUID() }]) {
        expectToolError(
          await callTool(lead, "register-chat-channel", {
            adapter: "telegram",
            channelId,
            ...args,
          }),
          "exclusive route target",
          "exactly one",
        );
      }
      expectToolError(
        await callTool(lead, "register-chat-channel", {
          adapter: "telegram",
          channelId,
          agentId: crypto.randomUUID(),
        }),
        "unknown agent",
        "not found",
      );
      for (const [name, args] of [
        ["chat-post", { adapter: "unknown", threadId, text: ctx.nonce }],
        ["chat-reply", { text: "" }],
        ["chat-read-thread", { threadId, limit: 101 }],
      ] as const) {
        const invalid = await callTool(lead, name, args);
        expect(
          invalid.isError && /validation|invalid/i.test(invalid.text),
          `${name} rejects invalid input`,
        );
      }

      const registered = expectToolOk(
        await callTool(lead, "register-chat-channel", {
          adapter: "telegram",
          channelId,
          agentId: workerId,
          name: ctx.nonce,
        }),
        "register channel",
      );
      expect(registered.data.key === key, "Registration normalizes the channel prefix");
      const mapping = asRecord(registered.data.mapping);
      expect(
        mapping.agentId === workerId &&
          mapping.name === ctx.nonce &&
          typeof mapping.createdAt === "string",
        "Registration returns the mapping",
      );
      expect(
        JSON.parse(mappingRow()?.value ?? "null").agentId === workerId,
        "Registration persists the mapping",
      );
      expectToolError(
        await callTool(worker, "unregister-chat-channel", { adapter: "telegram", channelId }),
        "worker removal",
        "Permission denied",
      );
      expect(Boolean(mappingRow()), "Denied removal preserves the mapping");
      const removed = expectToolOk(
        await callTool(lead, "unregister-chat-channel", { adapter: "telegram", channelId: key }),
        "unregister channel",
      );
      expect(
        removed.data.key === key && !mappingRow(),
        "Unregistration removes the persisted mapping",
      );
      expectToolError(
        await callTool(lead, "unregister-chat-channel", { adapter: "telegram", channelId }),
        "missing mapping",
        "No mapping found",
      );

      const task = await ctx.api("POST", "/api/tasks", {
        agentId: leadId,
        body: {
          task: `Chat SDK ${ctx.nonce}`,
          agentId: workerId,
          routingReason: "human_pinned",
          source: "chat",
          contextKey: `task:chat-sdk:telegram:${encodeURIComponent(channelId)}`,
        },
      });
      expectStatus(task, [201], "create a chat task");
      taskId = asString(asRecord(task.json).id, "chat task id");
      taskConnection = await ctx.connectMcp(workerId, { headers: { "X-Source-Task-ID": taskId } });
      expectToolError(
        await callTool(taskConnection, "chat-reply", { text: ctx.nonce }),
        "reply with disabled adapter",
        "not running",
      );
      expectToolError(
        await callTool(taskConnection, "chat-read-thread", { threadId }),
        "read own disabled thread",
        "not running",
      );
      expectToolError(
        await callTool(taskConnection, "chat-read-thread", { threadId: "telegram:991002" }),
        "read another thread",
        "You can read only the thread of your current task",
      );

      configId = asString(
        (
          await putConfig(ctx, {
            key: "CHAT_SDK_ADAPTERS",
            value: JSON.stringify({
              telegram: {
                botToken: `telegram-bot-${crypto.randomUUID()}`,
                secretToken: `telegram-webhook-${crypto.randomUUID()}`,
                mode: "webhook",
              },
            }),
          })
        ).id,
        "adapter config id",
      );
      await reloadConfig(ctx);
      const status = await ctx.api("GET", "/api/integrations/chat/status");
      expectStatus(status, [200], "enabled adapter status");
      expect(
        asRecords(status.json, "adapters").find((adapter) => adapter.name === "telegram")
          ?.health === "ok",
        "Telegram starts against the loopback mock",
      );
      const dm = expectToolOk(
        await callTool(lead, "chat-open-dm", { adapter: "telegram", userId: "991001" }),
        "open Telegram DM",
      );
      expect(
        dm.data.adapter === "telegram" && dm.data.threadId === "telegram:991001",
        "DM returns the Telegram thread",
      );
      for (const [connection, name, args] of [
        [lead, "chat-post", { adapter: "telegram", threadId, text: `post ${ctx.nonce}` }],
        [taskConnection, "chat-reply", { text: `reply ${ctx.nonce}` }],
      ] as const) {
        const sent = expectToolOk(await callTool(connection, name, args), name);
        expect(
          sent.data.adapter === "telegram" &&
            sent.data.threadId === threadId &&
            typeof sent.data.messageId === "string",
          `${name} returns the sent message`,
        );
        const request = calls.filter((call) => /^send(Rich)?Message$/.test(call.method)).at(-1);
        const text = request?.body.text ?? asRecord(request?.body.rich_message).markdown;
        expect(
          String(request?.body.chat_id) === channelId && text === args.text,
          `${name} sends the text to the task thread`,
        );
      }
      const history = expectToolOk(
        await callTool(taskConnection, "chat-read-thread", { threadId, limit: 10 }),
        "read own Telegram thread",
      );
      expect(
        history.data.threadId === threadId &&
          asRecords(history.data, "messages").some(
            (message) => message.text === `reply ${ctx.nonce}`,
          ),
        "Thread history includes the reply from this task",
      );
    } finally {
      try {
        if (taskId) await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} });
        await callTool(lead, "unregister-chat-channel", { adapter: "telegram", channelId });
        if (configId) {
          await deleteConfig(ctx, configId);
          await reloadConfig(ctx);
        }
      } finally {
        await Promise.all([
          taskConnection?.close(),
          worker.close(),
          lead.close(),
          ctx.api("POST", "/close", { agentId: leadId, body: {} }),
          ctx.api("POST", "/close", { agentId: workerId, body: {} }),
          mock.stop(true),
        ]);
      }
    }
  },
};
