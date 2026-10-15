import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  startTelegramBotApiMock,
  type TelegramBotApiMock,
} from "../../scripts/dev/telegram-bot-api-mock";
import { closeDb, createAgent, initDb } from "../be/db";
import { createIntegrationsHandler } from "../http/integrations";
import { getPathSegments } from "../http/utils";
import { stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { snapshotChatSdkEnv, TELEGRAM_SECRET } from "./chat-sdk-harness";
import { listenOnFreePort } from "./test-net";

/*
 * GET /api/integrations/chat/status and
 * POST /api/integrations/chat/telegram/register-webhook.
 * Telegram runs against the fake Bot API. Slack runs in socket mode against a
 * stub Web API that answers every method with `invalid_auth`, so the socket
 * start in `initialize()` fails at once (auth errors are not retried) and the
 * adapter health is `error`. (Webhook mode only warns on a failed auth.test.)
 */
const TEST_DB_PATH = "./test-chat-sdk-status-route.sqlite";
const PUBLIC_URL = "https://swarm.example.test";
const BOT_TOKEN = "123456:status-route-test-token";
const BOOT_ADAPTERS = {
  telegram: { botToken: BOT_TOKEN, secretToken: TELEGRAM_SECRET, mode: "webhook" },
  slack: { botToken: "xoxb-status-route", appToken: "xapp-status-route", mode: "socket" },
};
/** Configured but never started: `startChatSdk` ran before it was added. */
const DISCORD_ENTRY = {
  botToken: "discord-status-route-token",
  publicKey: "0".repeat(64),
  applicationId: "123456789012345678",
};

const restoreEnv = snapshotChatSdkEnv();
const savedPublicUrl = process.env.PUBLIC_MCP_BASE_URL;
let server: Server;
let baseUrl = "";
let telegram: TelegramBotApiMock;
let slackStub: ReturnType<typeof Bun.serve>;
let leadId = "";
let workerId = "";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  leadId = (
    await createAgent({
      id: crypto.randomUUID(),
      name: "StatusRouteLead",
      isLead: true,
      status: "idle",
      capabilities: [],
    })
  ).id;
  workerId = (
    await createAgent({
      id: crypto.randomUUID(),
      name: "StatusRouteWorker",
      isLead: false,
      status: "idle",
      capabilities: [],
    })
  ).id;

  telegram = startTelegramBotApiMock();
  slackStub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ ok: false, error: "invalid_auth" }),
  });
  process.env.PUBLIC_MCP_BASE_URL = PUBLIC_URL;
  process.env.SLACK_DISABLE = "true";
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify(BOOT_ADAPTERS);
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({
    telegram: telegram.url,
    slack: `http://127.0.0.1:${slackStub.port}/api/`,
  });
  await startChatSdk();
  await stopChatRelayWatcher();

  const handler = createIntegrationsHandler();
  server = createHttpServer(async (req, res) => {
    const handled = await handler(req, res, getPathSegments(req.url || ""));
    if (!handled) {
      res.writeHead(404);
      res.end("not found");
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  server.close();
  await stopChatSdk();
  telegram.stop();
  slackStub.stop(true);
  closeDb();
  await removeDbFiles();
  restoreEnv();
  if (savedPublicUrl === undefined) delete process.env.PUBLIC_MCP_BASE_URL;
  else process.env.PUBLIC_MCP_BASE_URL = savedPublicUrl;
});

/** Run `fn` with temporary env values, then restore them (undefined deletes). */
async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function getStatus(): Promise<StatusBody> {
  const res = await fetch(`${baseUrl}/api/integrations/chat/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

async function registerAsLead(): Promise<Response> {
  return fetch(`${baseUrl}/api/integrations/chat/telegram/register-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-id": leadId },
    body: "{}",
  });
}

interface StatusBody {
  enabled: boolean;
  slackClash: boolean;
  error?: string;
  adapters: Array<{
    name: string;
    configured: boolean;
    enabled: boolean;
    health: string;
    error?: string;
    webhookUrl: string;
    mode?: string;
    guilds?: { count: number; names: string[] };
  }>;
}

describe("GET /api/integrations/chat/status", () => {
  test("reports one ok and one error adapter, webhook URLs, and no secrets", async () => {
    const res = await fetch(`${baseUrl}/api/integrations/chat/status`);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [BOT_TOKEN, TELEGRAM_SECRET, "xoxb-status-route", "xapp-status-route"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text) as StatusBody;
    expect(body.enabled).toBe(true);
    expect(body.slackClash).toBe(false);
    const byName = Object.fromEntries(body.adapters.map((a) => [a.name, a]));
    expect(Object.keys(byName).sort()).toEqual(["discord", "slack", "teams", "telegram"]);

    expect(byName.telegram).toMatchObject({
      configured: true,
      health: "ok",
      mode: "webhook",
      webhookUrl: `${PUBLIC_URL}/api/integrations/chat/telegram/webhook`,
    });
    expect(byName.telegram?.error).toBeUndefined();

    expect(byName.slack).toMatchObject({ configured: true, health: "error", mode: "socket" });
    expect(byName.slack?.error).toContain("invalid_auth");

    expect(byName.discord).toMatchObject({
      configured: false,
      health: "disabled",
      webhookUrl: `${PUBLIC_URL}/api/integrations/chat/discord/webhook`,
    });
    expect(byName.teams).toMatchObject({ configured: false, health: "disabled" });
  });

  test("flags the Slack clash when SLACK_DISABLE is not true", async () => {
    process.env.SLACK_DISABLE = "false";
    try {
      const body = (await (
        await fetch(`${baseUrl}/api/integrations/chat/status`)
      ).json()) as StatusBody;
      expect(body.slackClash).toBe(true);
    } finally {
      process.env.SLACK_DISABLE = "true";
    }
  });

  test("a configured adapter that is not running says it is still starting", async () => {
    await withEnv(
      { CHAT_SDK_ADAPTERS: JSON.stringify({ ...BOOT_ADAPTERS, discord: DISCORD_ENTRY }) },
      async () => {
        const discord = (await getStatus()).adapters.find((a) => a.name === "discord");
        expect(discord).toMatchObject({ configured: true, health: "disabled" });
        expect(discord?.error).toStartWith("The adapter is starting");
      },
    );
  });

  test("a Slack clash blocks boot: the idle adapter says Not started with the cause", async () => {
    await withEnv(
      {
        SLACK_DISABLE: "false",
        CHAT_SDK_ADAPTERS: JSON.stringify({ ...BOOT_ADAPTERS, discord: DISCORD_ENTRY }),
      },
      async () => {
        const body = await getStatus();
        expect(body.slackClash).toBe(true);
        const discord = body.adapters.find((a) => a.name === "discord");
        expect(discord?.error).toStartWith("Not started: ");
        expect(discord?.error).toContain("SLACK_DISABLE=true");
      },
    );
  });

  test("a missing $config row makes that adapter incomplete; the others keep running", async () => {
    const discord = { ...DISCORD_ENTRY, botToken: { $config: "CHAT_SDK_DISCORD_STATUS_MISSING" } };
    await withEnv(
      { CHAT_SDK_ADAPTERS: JSON.stringify({ ...BOOT_ADAPTERS, discord }) },
      async () => {
        const body = await getStatus();
        expect(body.error).toBeUndefined();
        const entry = body.adapters.find((a) => a.name === "discord");
        expect(entry).toMatchObject({ configured: true, health: "incomplete" });
        expect(entry?.error).toContain("CHAT_SDK_DISCORD_STATUS_MISSING");
        expect(entry?.error?.length ?? 0).toBeLessThanOrEqual(300);
        expect(body.adapters.find((a) => a.name === "telegram")?.health).toBe("ok");
      },
    );
  });

  test("a partial save (required field missing) is incomplete and names the field", async () => {
    await withEnv(
      { CHAT_SDK_ADAPTERS: JSON.stringify({ ...BOOT_ADAPTERS, discord: { botToken: "x" } }) },
      async () => {
        const body = await getStatus();
        expect(body.error).toBeUndefined();
        const entry = body.adapters.find((a) => a.name === "discord");
        expect(entry).toMatchObject({ configured: true, health: "incomplete" });
        expect(entry?.error).toBe("CHAT_SDK_ADAPTERS.discord.publicKey: required");
        expect(entry?.guilds).toBeUndefined();
      },
    );
  });

  test("an entry with enabled: false is configured, not enabled, and says the config is kept", async () => {
    await withEnv(
      {
        CHAT_SDK_ADAPTERS: JSON.stringify({
          ...BOOT_ADAPTERS,
          discord: { ...DISCORD_ENTRY, enabled: false },
        }),
      },
      async () => {
        const body = await getStatus();
        const entry = body.adapters.find((a) => a.name === "discord");
        expect(entry).toMatchObject({ configured: true, enabled: false, health: "disabled" });
        expect(entry?.error).toContain("configuration is kept");
        expect(body.adapters.find((a) => a.name === "telegram")?.enabled).toBe(true);
      },
    );
  });

  test("a forbidden key blocks boot: Not started with the config error, bounded", async () => {
    const discord = { ...DISCORD_ENTRY, apiUrl: "http://evil.example" };
    await withEnv(
      { CHAT_SDK_ADAPTERS: JSON.stringify({ ...BOOT_ADAPTERS, discord }) },
      async () => {
        const body = await getStatus();
        expect(body.error).toContain("discord.apiUrl");
        expect(body.error?.length ?? 0).toBeLessThanOrEqual(300);
        const entry = body.adapters.find((a) => a.name === "discord");
        expect(entry?.error).toStartWith("Not started: ");
        expect(entry?.error).toContain("discord.apiUrl");
      },
    );
  });

  test("invalid JSON reports a fixed error without the parser message or the input", async () => {
    const broken = `{"telegram":{"botToken":"${BOT_TOKEN}",`;
    await withEnv({ CHAT_SDK_ADAPTERS: broken }, async () => {
      const res = await fetch(`${baseUrl}/api/integrations/chat/status`);
      const text = await res.text();
      expect(text).not.toContain(BOT_TOKEN);
      expect((JSON.parse(text) as StatusBody).error).toBe("CHAT_SDK_ADAPTERS is not valid JSON");
    });
  });
});

describe("POST /api/integrations/chat/telegram/register-webhook", () => {
  test("refuses a non-lead agent with 403 and calls no Bot API method", async () => {
    const before = telegram.calls.length;
    const res = await fetch(`${baseUrl}/api/integrations/chat/telegram/register-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": workerId },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(telegram.calls.slice(before).map((c) => c.method)).not.toContain("setWebhook");
  });

  test("lead registers the public URL and secret, gets getWebhookInfo back", async () => {
    const before = telegram.calls.length;
    const res = await fetch(`${baseUrl}/api/integrations/chat/telegram/register-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": leadId },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const expectedUrl = `${PUBLIC_URL}/api/integrations/chat/telegram/webhook`;
    const body = (await res.json()) as {
      webhookUrl: string;
      webhookInfo: { url: string; pending_update_count?: number };
    };
    expect(body.webhookUrl).toBe(expectedUrl);
    expect(body.webhookInfo.url).toBe(expectedUrl);
    expect(body.webhookInfo.pending_update_count).toBe(0);

    const calls = telegram.calls.slice(before);
    expect(calls.map((c) => c.method)).toEqual(["setWebhook", "getWebhookInfo"]);
    expect(calls[0]?.body).toEqual({ url: expectedUrl, secret_token: TELEGRAM_SECRET });
  });

  test("400 in polling mode, with no Bot API call", async () => {
    const before = telegram.calls.length;
    const adapters = { ...BOOT_ADAPTERS, telegram: { botToken: BOT_TOKEN, mode: "polling" } };
    await withEnv({ CHAT_SDK_ADAPTERS: JSON.stringify(adapters) }, async () => {
      const res = await registerAsLead();
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("polling mode");
    });
    expect(telegram.calls.length).toBe(before);
  });

  test("400 says the channel is disabled when CHAT_SDK_ENABLED is false", async () => {
    const before = telegram.calls.length;
    await withEnv({ CHAT_SDK_ENABLED: "false" }, async () => {
      const res = await registerAsLead();
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("disabled");
      expect(error).not.toContain("not configured");
    });
    expect(telegram.calls.length).toBe(before);
  });

  test("502 when the Bot API rejects setWebhook, with the bot token redacted", async () => {
    telegram.failSetWebhook(true);
    try {
      const res = await registerAsLead();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain(BOT_TOKEN);
      const { error } = JSON.parse(text) as { error: string };
      expect(error).toContain("Telegram setWebhook failed");
      expect(error).toContain("[REDACTED]");
    } finally {
      telegram.failSetWebhook(false);
    }
  });
});
