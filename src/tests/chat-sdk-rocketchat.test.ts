import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { validateConfigValue } from "../be/swarm-config-guard";
import { drainBackground } from "../integrations/chat-sdk/background";
import { getChatSdkConfig } from "../integrations/chat-sdk/config";
import { stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { ChatSdkAdaptersSchema } from "../integrations/chat-sdk/schema";
import { getChatSdkStatus } from "../integrations/chat-sdk/status";
import { flushChatBuffers, postChatWebhook, snapshotChatSdkEnv } from "./chat-sdk-harness";
import { getFreePort } from "./test-net";

/*
 * Rocket.Chat is self-hosted, so the instance URL comes from the env-only
 * `CHAT_SDK_API_URL_OVERRIDES` and never from the adapter config. The tests
 * point it at a port nothing listens on: inbound needs no call to the server,
 * and an unexpected outbound REST call fails here instead of reaching a host.
 */
const TEST_DB_PATH = "./test-chat-sdk-rocketchat.sqlite";
const WEBHOOK_TOKEN = "rc-outgoing-webhook-token";
const BOT_USER_ID = "rc-bot-user-id";
const TOKEN = "rc-personal-access-token";

const restoreEnv = snapshotChatSdkEnv();
let leadId: string;
let unreachableInstanceUrl = "";
let nextMessageId = 1;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

const VALID_ENTRY = { token: TOKEN, botUserId: BOT_USER_ID, webhookToken: WEBHOOK_TOKEN };

async function startRocketchat(entry: Record<string, unknown> = VALID_ENTRY): Promise<void> {
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({ rocketchat: entry });
  await startChatSdk();
  await stopChatRelayWatcher();
}

/** An Outgoing WebHook payload for a channel message that mentions the bot. */
function outgoingWebhook(
  channelId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    token: WEBHOOK_TOKEN,
    message_id: `msg-${++nextMessageId}`,
    timestamp: new Date().toISOString(),
    channel_id: channelId,
    channel_name: "general",
    user_id: "rc-human-user",
    user_name: "tester",
    text,
    ...extra,
  };
}

async function postWebhook(payload: unknown) {
  return postChatWebhook("rocketchat", JSON.stringify(payload), {
    "content-type": "application/json",
  });
}

async function taskCount(like: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_tasks WHERE task LIKE ?",
    [`%${like}%`],
  );
  return row?.n ?? 0;
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const lead = await createAgent({
    id: crypto.randomUUID(),
    name: "RocketChatLead",
    isLead: true,
    status: "idle",
    capabilities: [],
  });
  leadId = lead.id;
  unreachableInstanceUrl = `http://127.0.0.1:${await getFreePort()}`;
  process.env.CHAT_SDK_BUFFER_MS = "60000";
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ rocketchat: unreachableInstanceUrl });
});

afterEach(async () => {
  await stopChatSdk();
});

afterAll(async () => {
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("Rocket.Chat adapter config", () => {
  test("requires the token, bot user id and webhook token", async () => {
    expect(ChatSdkAdaptersSchema.safeParse({ rocketchat: VALID_ENTRY }).success).toBe(true);
    for (const missing of ["token", "botUserId", "webhookToken"] as const) {
      const { [missing]: _dropped, ...rest } = VALID_ENTRY;
      process.env.CHAT_SDK_ENABLED = "true";
      process.env.CHAT_SDK_ADAPTERS = JSON.stringify({ rocketchat: rest });
      const config = await getChatSdkConfig();
      expect(config.adapters).toEqual({});
      expect(config.incomplete?.rocketchat).toBe(
        `CHAT_SDK_ADAPTERS.rocketchat.${missing}: required`,
      );
    }
  });

  test("rejects an operator-set instance URL under any base-URL key", () => {
    for (const key of ["baseUrl", "apiUrl", "apiBaseUrl"]) {
      const error = validateConfigValue(
        "CHAT_SDK_ADAPTERS",
        JSON.stringify({ rocketchat: { ...VALID_ENTRY, [key]: "https://evil.example" } }),
      );
      expect(error).toContain(`rocketchat.${key}`);
    }
  });

  test("resolves the token from a $config ref as a plain string", async () => {
    const { upsertSwarmConfig } = await import("../be/db");
    await upsertSwarmConfig({
      scope: "global",
      key: "RC_TOKEN",
      value: "token-from-config",
      isSecret: true,
    });
    process.env.CHAT_SDK_ENABLED = "true";
    process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
      rocketchat: { ...VALID_ENTRY, token: { $config: "RC_TOKEN" } },
    });
    const config = await getChatSdkConfig();
    expect(config.error).toBeUndefined();
    // The adapter puts `token` straight into the REST header, so it must not
    // become a resolver function like `botToken` does.
    expect(config.adapters.rocketchat?.token).toBe("token-from-config");
  });
});

describe("Rocket.Chat adapter status", () => {
  test("names the missing env var when the instance URL override is absent", async () => {
    const saved = process.env.CHAT_SDK_API_URL_OVERRIDES;
    delete process.env.CHAT_SDK_API_URL_OVERRIDES;
    try {
      process.env.CHAT_SDK_ENABLED = "true";
      process.env.CHAT_SDK_ADAPTERS = JSON.stringify({ rocketchat: VALID_ENTRY });
      const status = await getChatSdkStatus();
      const rocketchat = status.adapters.find((adapter) => adapter.name === "rocketchat");
      expect(rocketchat?.configured).toBe(true);
      expect(rocketchat?.error).toContain("CHAT_SDK_API_URL_OVERRIDES");
    } finally {
      if (saved === undefined) delete process.env.CHAT_SDK_API_URL_OVERRIDES;
      else process.env.CHAT_SDK_API_URL_OVERRIDES = saved;
    }
  });
});

describe("Rocket.Chat webhook", () => {
  test("a mention with the right token creates a rocketchat chat task", async () => {
    await startRocketchat();
    expect(getChatSdkHealth().rocketchat?.status).toBe("ok");

    const response = await postWebhook(outgoingWebhook("rc-room-one", "@swarm triage the inbox"));
    expect(response.status).toBe(200);
    expect(await drainBackground(5_000)).toBe(true);
    await flushChatBuffers();

    const tasks = await getDbClient().query<{
      contextKey: string;
      source: string;
      agentId: string | null;
      task: string;
    }>("SELECT contextKey, source, agentId, task FROM agent_tasks WHERE contextKey GLOB ?", [
      "task:chat-sdk:rocketchat:*",
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toBe("chat");
    expect(tasks[0]!.agentId).toBe(leadId);
    expect(tasks[0]!.task).toContain("triage the inbox");
  });

  test("a wrong or missing webhook token is rejected with 401", async () => {
    await startRocketchat();
    for (const token of ["not-the-token", ""]) {
      const response = await postWebhook(
        outgoingWebhook("rc-room-two", "@swarm should not land", { token }),
      );
      expect(response.status).toBe(401);
    }
    await flushChatBuffers();
    expect(await taskCount("should not land")).toBe(0);
  });

  test("the bot's own message is ignored", async () => {
    await startRocketchat();
    const response = await postWebhook(
      outgoingWebhook("rc-room-three", "@swarm echo of myself", {
        user_id: BOT_USER_ID,
        user_name: "swarm",
      }),
    );
    expect(response.status).toBe(200);
    await flushChatBuffers();
    expect(await taskCount("echo of myself")).toBe(0);
  });

  test("the webhook stays closed while no adapter is configured", async () => {
    process.env.CHAT_SDK_ENABLED = "true";
    process.env.CHAT_SDK_ADAPTERS = JSON.stringify({});
    await startChatSdk();
    const response = await postWebhook(outgoingWebhook("rc-room-four", "@swarm nobody home"));
    expect(response.status).toBe(404);
  });
});
