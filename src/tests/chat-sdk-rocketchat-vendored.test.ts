import { describe, expect, test } from "bun:test";
import { NetworkError } from "@chat-adapter/shared";
import { createRocketChatAdapter } from "../integrations/chat-sdk/rocketchat/index";

const WEBHOOK_TOKEN = "rc-outgoing-webhook-token";

function adapterFor(baseUrl: string) {
  return createRocketChatAdapter({
    baseUrl,
    token: "rc-personal-access-token",
    botUserId: "rc-bot-user-id",
    webhookToken: WEBHOOK_TOKEN,
    userName: "swarm",
  });
}

function webhook(token: string | undefined): Request {
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: JSON.stringify({ token, message_id: "m1", channel_id: "room", user_id: "u1", text: "" }),
  });
}

describe("vendored Rocket.Chat adapter", () => {
  test("loads from the repo with no chat-adapter-rocketchat npm package", async () => {
    expect(() => Bun.resolveSync("chat-adapter-rocketchat", import.meta.dir)).toThrow();
    const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();
    expect(pkg.dependencies?.["chat-adapter-rocketchat"]).toBeUndefined();
    expect(adapterFor("https://chat.example.com/").name).toBe("rocketchat");
  });

  test("the webhook token check rejects a wrong, shorter, longer or missing token", async () => {
    const adapter = adapterFor("https://chat.example.com");
    // No Chat instance is attached, so a valid token answers 200 without processing.
    expect((await adapter.handleWebhook(webhook(WEBHOOK_TOKEN))).status).toBe(200);
    for (const token of ["x".repeat(WEBHOOK_TOKEN.length), "short", `${WEBHOOK_TOKEN}-x`, ""]) {
      expect((await adapter.handleWebhook(webhook(token))).status).toBe(401);
    }
    expect((await adapter.handleWebhook(webhook(undefined))).status).toBe(401);
  });

  test("the auth token never follows a redirect to another origin", async () => {
    const seen: Array<string | null> = [];
    const foreign = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("x-auth-token"));
        return Response.json({ success: true, message: { _id: "m1" } });
      },
    });
    const instance = Bun.serve({
      port: 0,
      fetch: () =>
        Response.redirect(`http://127.0.0.1:${foreign.port}/api/v1/chat.postMessage`, 307),
    });
    try {
      const adapter = adapterFor(`http://localhost:${instance.port}`);
      await expect(
        adapter.postMessage("rocketchat:room", { markdown: "hi" }),
      ).rejects.toBeInstanceOf(NetworkError);
      expect(seen).toEqual([]);
    } finally {
      instance.stop(true);
      foreign.stop(true);
    }
  });
});
