/**
 * Shared harness for Chat SDK tests that drive platform webhooks through the
 * real route. Telegram runs against the fake Bot API
 * (`scripts/dev/telegram-bot-api-mock.ts`); `postChatWebhook` and
 * `snapshotChatSdkEnv` serve the Slack and Teams tests too.
 */
import { expect } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  startTelegramBotApiMock,
  type TelegramBotApiMock,
} from "../../scripts/dev/telegram-bot-api-mock";
import { handleWebhooks } from "../http/webhooks";
import { drainBackground } from "../integrations/chat-sdk/background";
import { startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { flushAllChatBuffers } from "../integrations/chat-sdk/thread-buffer";

export const TELEGRAM_SECRET = "chat-sdk-test-secret";
const ENV_KEYS = [
  "CHAT_SDK_ENABLED",
  "CHAT_SDK_ADAPTERS",
  "CHAT_SDK_API_URL_OVERRIDES",
  "CHAT_SDK_BUFFER_MS",
  "SLACK_DISABLE",
];

/** Save the Chat SDK env keys; the returned function restores them. */
export function snapshotChatSdkEnv(): () => void {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

let nextUpdateId = 950_000;
let nextMessageId = 5_000;

export interface TelegramHarness {
  mock: TelegramBotApiMock;
  stop: () => Promise<void>;
}

/** Start the mock Bot API and a webhook-mode Telegram adapter pointed at it. */
export async function startTelegramHarness(bufferMs = 60_000): Promise<TelegramHarness> {
  const restoreEnv = snapshotChatSdkEnv();
  const mock = startTelegramBotApiMock();
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
    telegram: { botToken: "t", secretToken: TELEGRAM_SECRET, mode: "webhook" },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ telegram: mock.url });
  process.env.CHAT_SDK_BUFFER_MS = String(bufferMs);
  await startChatSdk();
  return {
    mock,
    stop: async () => {
      await stopChatSdk();
      mock.stop();
      restoreEnv();
    },
  };
}

export interface TelegramChat {
  id: number;
  type: "private" | "group";
}

/** A Telegram `message` update from a human in `chat`. */
export function telegramUpdate(
  chat: TelegramChat,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const from = { id: 777_001, is_bot: false, first_name: "Tester", username: "tester" };
  return {
    update_id: ++nextUpdateId,
    message: {
      message_id: ++nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat:
        chat.type === "private"
          ? { id: chat.id, type: "private", first_name: "Tester" }
          : { id: chat.id, type: "group", title: "Swarm group" },
      from,
      ...(text ? { text } : {}),
      ...extra,
    },
  };
}

export interface ChatWebhookResponse {
  status: number;
  body: string;
}

/** POST a raw body to `/api/integrations/chat/{adapter}/webhook` through `handleWebhooks`. */
export async function postChatWebhook(
  adapter: string,
  body: string,
  headers: Record<string, string>,
): Promise<ChatWebhookResponse> {
  const path = `/api/integrations/chat/${adapter}/webhook`;
  const req = {
    method: "POST",
    url: path,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawHeaders: Object.entries(headers).flat(),
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
  const captured = { status: 0, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body = chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;
  expect(await handleWebhooks(req, res, path.split("/").filter(Boolean))).toBe(true);
  return captured;
}

/** POST one update to the Telegram webhook and wait for the handler work. */
export async function postTelegramUpdate(update: unknown): Promise<void> {
  const response = await postChatWebhook("telegram", JSON.stringify(update), {
    "content-type": "application/json",
    "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
  });
  expect(response.status).toBe(200);
  expect(await drainBackground(5_000)).toBe(true);
}

/** Flush every waiting thread (no timer wait) and wait for the resulting work. */
export async function flushChatBuffers(): Promise<void> {
  await flushAllChatBuffers();
  expect(await drainBackground(5_000)).toBe(true);
}
