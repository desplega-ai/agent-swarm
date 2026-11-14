import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  deleteConfig,
  expectToolOk,
  putConfig,
  registerAgent,
  reloadConfig,
} from "./platform-helpers";

// Rocket.Chat through the in-repo Chat SDK adapter: config validation, the Outgoing WebHook
// token check, a mention becoming a chat task, the unmapped sender queue, and a REST reply
// to a loopback instance bound at the deployment's CHAT_SDK_API_URL_OVERRIDES.rocketchat.

const WEBHOOK = "/api/integrations/chat/rocketchat/webhook";
const BOT_USER_ID = "rc-bot-user-id";

export const platformChatSdkRocketchat: Scenario = {
  name: "platform-chat-sdk-rocketchat",
  order: 654,
  async run(ctx) {
    const leadId = await registerAgent(ctx, "rocketchat-lead", { lead: true });
    const lead = await ctx.connectMcp(leadId);
    const token = `rc-token-${crypto.randomUUID()}`;
    const webhookToken = `rc-webhook-${crypto.randomUUID()}`;
    const entry = { token, botUserId: BOT_USER_ID, webhookToken, userName: "swarm" };
    const roomId = `room-${ctx.nonce}`;
    const senderId = `rc-user-${ctx.nonce}`;
    const posts: Array<{ authToken: string | null; body: Record<string, unknown> }> = [];
    const origin = asString(
      asRecord(JSON.parse(ctx.sutEnv.CHAT_SDK_API_URL_OVERRIDES ?? "{}")).rocketchat,
      "Rocket.Chat mock origin",
    );
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(origin).port),
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/chat.postMessage") {
          const body = asRecord(await request.json());
          posts.push({ authToken: request.headers.get("x-auth-token"), body });
          return Response.json({
            success: true,
            message: {
              _id: `rc-msg-${posts.length}`,
              rid: body.roomId,
              msg: body.text,
              ts: new Date().toISOString(),
              u: { _id: BOT_USER_ID, username: "swarm" },
            },
          });
        }
        return Response.json({ success: false, error: `Unexpected ${path}` }, { status: 404 });
      },
    });
    let configId: string | undefined;
    const webhook = (payload: Record<string, unknown>) =>
      ctx.api("POST", WEBHOOK, {
        apiKey: null,
        headers: { "content-type": "application/json" },
        rawBody: JSON.stringify({
          token: webhookToken,
          message_id: `rc-${crypto.randomUUID()}`,
          timestamp: String(Date.now()),
          channel_id: roomId,
          channel_name: "general",
          user_id: senderId,
          user_name: "tester",
          ...payload,
        }),
      });
    const chatTasks = (text: string) =>
      ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agent_tasks WHERE contextKey GLOB ? AND task LIKE ?",
        [`task:chat-sdk:rocketchat:*`, `%${text}%`],
      )?.n ?? 0;
    try {
      for (const key of ["baseUrl", "apiUrl", "apiBaseUrl"]) {
        const rejected = await ctx.api("PUT", "/api/config", {
          body: {
            scope: "global",
            key: "CHAT_SDK_ADAPTERS",
            value: JSON.stringify({ rocketchat: { ...entry, [key]: "https://other.example" } }),
          },
        });
        expectStatus(rejected, [400], `config rejects rocketchat.${key}`);
      }

      const { userName: _dropped, ...withoutUserName } = entry;
      configId = asString(
        (
          await putConfig(ctx, {
            key: "CHAT_SDK_ADAPTERS",
            value: JSON.stringify({ rocketchat: withoutUserName }),
          })
        ).id,
        "incomplete adapter config id",
      );
      await reloadConfig(ctx);
      const incomplete = asRecords(
        (await ctx.api("GET", "/api/integrations/chat/status")).json,
        "adapters",
      ).find((adapter) => adapter.name === "rocketchat");
      expect(
        incomplete?.health === "incomplete" && String(incomplete.error).includes("userName"),
        "A Rocket.Chat entry without userName is incomplete",
      );

      configId = asString(
        (
          await putConfig(ctx, {
            key: "CHAT_SDK_ADAPTERS",
            value: JSON.stringify({ rocketchat: entry }),
          })
        ).id,
        "adapter config id",
      );
      await reloadConfig(ctx);
      expect(
        await pollUntil(async () => {
          const status = await ctx.api("GET", "/api/integrations/chat/status");
          return (
            asRecords(status.json, "adapters").find((adapter) => adapter.name === "rocketchat")
              ?.health === "ok"
          );
        }, 15_000),
        "The in-repo Rocket.Chat adapter starts against the loopback instance",
      );

      for (const wrong of ["not-the-token", webhookToken.slice(1), ""]) {
        expectStatus(
          await webhook({ token: wrong, text: `@swarm wrong token ${ctx.nonce}` }),
          [401],
          "a wrong webhook token",
        );
      }
      expectStatus(
        await webhook({
          user_id: BOT_USER_ID,
          user_name: "swarm",
          text: `@swarm self ${ctx.nonce}`,
        }),
        [200],
        "the bot's own message",
      );
      expectStatus(
        await webhook({ text: `@swarm triage ${ctx.nonce}` }),
        [200],
        "a mention with the right token",
      );
      expect(
        await pollUntil(() => chatTasks(`triage ${ctx.nonce}`) === 1, 15_000),
        "A mention becomes one Rocket.Chat chat task",
      );
      expect(
        chatTasks(`wrong token ${ctx.nonce}`) === 0 && chatTasks(`self ${ctx.nonce}`) === 0,
        "Rejected and self messages create no task",
      );
      expect(
        await pollUntil(async () => {
          const unmapped = await ctx.api("GET", "/api/users/unmapped");
          return asRecords(unmapped.json, "unmapped").some(
            (row) => row.kind === "rocketchat" && row.externalId === senderId,
          );
        }, 10_000),
        "The unlinked sender appears in the default unmapped list",
      );

      const text = `post ${ctx.nonce}`;
      expectToolOk(
        await callTool(lead, "chat-post", {
          adapter: "rocketchat",
          threadId: `rocketchat:${roomId}`,
          text,
        }),
        "chat-post to Rocket.Chat",
      );
      const sent = posts.find((post) => post.body.text === text);
      expect(
        sent?.authToken === token && sent.body.roomId === roomId,
        "chat-post calls chat.postMessage on the instance with the bot token",
      );
    } finally {
      try {
        if (configId) {
          await deleteConfig(ctx, configId);
          await reloadConfig(ctx);
        }
      } finally {
        await Promise.all([
          lead.close(),
          ctx.api("POST", "/close", { agentId: leadId, body: {} }),
          mock.stop(true),
        ]);
      }
    }
  },
};
