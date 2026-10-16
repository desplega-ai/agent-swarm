import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  startTelegramBotApiMock,
  type TelegramBotApiMock,
} from "../../scripts/dev/telegram-bot-api-mock";
import { closeDb, deleteSwarmConfig, initDb, upsertSwarmConfig } from "../be/db";
import { __resetInjectedEnvTracking, reloadGlobalConfigsAndIntegrations } from "../http/core";
import { getChatInstance, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { snapshotChatSdkEnv, TELEGRAM_SECRET } from "./chat-sdk-harness";

/**
 * A dashboard save writes swarm_config rows and triggers the integrations
 * reload. The reload restarts the Chat SDK adapters only when their resolved
 * config changed.
 */

const TEST_DB_PATH = "./test-chat-sdk-reload.sqlite";
const DISABLE_KEYS = [
  "AGENTMAIL_DISABLE",
  "GITHUB_DISABLE",
  "JIRA_DISABLE",
  "LINEAR_DISABLE",
  "SLACK_DISABLE",
];
const restoreChatEnv = snapshotChatSdkEnv();
const savedDisable = new Map(DISABLE_KEYS.map((key) => [key, process.env[key]]));
let mock: TelegramBotApiMock;
const rowIds: string[] = [];

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

function getMeCalls(): number {
  return mock.calls.filter((call) => call.method === "getMe").length;
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  __resetInjectedEnvTracking();
  for (const key of DISABLE_KEYS) process.env[key] = "true";
  delete process.env.CHAT_SDK_ENABLED;
  delete process.env.CHAT_SDK_ADAPTERS;
  mock = startTelegramBotApiMock();
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ telegram: mock.url });
});

afterAll(async () => {
  await stopChatSdk();
  mock.stop();
  closeDb();
  await removeDbFiles();
  __resetInjectedEnvTracking();
  restoreChatEnv();
  for (const [key, value] of savedDisable) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Chat SDK restart on config reload", () => {
  test("saving the config rows starts the Telegram adapter without a restart", async () => {
    expect(getChatInstance("telegram")).toBeUndefined();
    for (const [key, value, isSecret] of [
      ["CHAT_SDK_TELEGRAM_BOT_TOKEN", "token-one", true],
      ["CHAT_SDK_ENABLED", "true", false],
      [
        "CHAT_SDK_ADAPTERS",
        JSON.stringify({
          telegram: {
            botToken: { $config: "CHAT_SDK_TELEGRAM_BOT_TOKEN" },
            secretToken: TELEGRAM_SECRET,
            mode: "webhook",
          },
        }),
        false,
      ],
    ] as const) {
      rowIds.push((await upsertSwarmConfig({ scope: "global", key, value, isSecret })).id);
    }

    const result = await reloadGlobalConfigsAndIntegrations();

    expect(result.integrationsReinitialized).toContain("chat-sdk");
    expect(getChatInstance("telegram")).toBeDefined();
  });

  test("a reload with no Chat SDK change leaves the running adapter alone", async () => {
    const before = getChatInstance("telegram");
    const getMeBefore = getMeCalls();

    const result = await reloadGlobalConfigsAndIntegrations();

    expect(result.integrationsReinitialized).not.toContain("chat-sdk");
    expect(getChatInstance("telegram")).toBe(before);
    expect(getMeCalls()).toBe(getMeBefore);
  });

  test("rotating a $config secret restarts the adapter", async () => {
    const before = getChatInstance("telegram");
    await upsertSwarmConfig({
      scope: "global",
      key: "CHAT_SDK_TELEGRAM_BOT_TOKEN",
      value: "token-two",
      isSecret: true,
    });

    const result = await reloadGlobalConfigsAndIntegrations();

    expect(result.integrationsReinitialized).toContain("chat-sdk");
    const after = getChatInstance("telegram");
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("deleting the config rows stops the adapter", async () => {
    for (const id of rowIds) await deleteSwarmConfig(id);

    const result = await reloadGlobalConfigsAndIntegrations();

    expect(result.integrationsReinitialized).not.toContain("chat-sdk");
    expect(getChatInstance("telegram")).toBeUndefined();
  });
});
