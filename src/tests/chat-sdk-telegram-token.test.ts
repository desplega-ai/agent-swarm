import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  startTelegramBotApiMock,
  type TelegramBotApiMock,
} from "../../scripts/dev/telegram-bot-api-mock";
import { closeDb, initDb } from "../be/db";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { healthyChatSdkAdapters } from "../integrations/chat-sdk/status";
import { snapshotChatSdkEnv, TELEGRAM_SECRET } from "./chat-sdk-harness";

/*
 * In webhook mode the Telegram adapter starts without checking the token, so
 * `setMyCommands` at start is the first call that does. A 401 there must mark
 * the adapter failed, so the status and the checklist do not read "Connected".
 */
const TEST_DB_PATH = "./test-chat-sdk-telegram-token.sqlite";
const restoreEnv = snapshotChatSdkEnv();
let mock: TelegramBotApiMock;

async function boot(): Promise<void> {
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
    telegram: { botToken: "123:fake-token", secretToken: TELEGRAM_SECRET, mode: "webhook" },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ telegram: mock.url });
  await startChatSdk();
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  mock = startTelegramBotApiMock();
});

afterEach(async () => {
  await stopChatSdk();
  mock.rejectToken(false);
  mock.calls.length = 0;
});

afterAll(async () => {
  mock.stop();
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("Telegram token check at start", () => {
  test("a 401 from setMyCommands marks the adapter failed with the reason", async () => {
    mock.rejectToken(true);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await boot();
    } finally {
      error.mockRestore();
    }
    expect(mock.calls.some((call) => call.method === "setMyCommands")).toBe(true);
    const health = getChatSdkHealth().telegram;
    expect(health?.status).toBe("error");
    expect(health?.error).toContain("Telegram rejected the bot token");
    expect(health?.error).not.toContain("fake-token");
    expect(healthyChatSdkAdapters()).not.toContain("telegram");
  });

  test("a valid token starts the adapter as ok", async () => {
    await boot();
    expect(getChatSdkHealth().telegram?.status).toBe("ok");
    expect(healthyChatSdkAdapters()).toContain("telegram");
  });
});
