import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  startTelegramBotApiMock,
  type TelegramBotApiMock,
} from "../../scripts/dev/telegram-bot-api-mock";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { handleWebhooks } from "../http/webhooks";
import { drainBackground } from "../integrations/chat-sdk/background";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { flushAllChatBuffers } from "../integrations/chat-sdk/thread-buffer";
import { getEnabledCapabilities } from "../server";
import privateText from "./fixtures/chat-sdk/telegram-private-text.json";

const TEST_DB_PATH = "./test-chat-sdk-telegram.sqlite";
const SECRET = "s";
const ENV_KEYS = ["CHAT_SDK_ENABLED", "CHAT_SDK_ADAPTERS", "CHAT_SDK_API_URL_OVERRIDES"];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let mock: TelegramBotApiMock;
let leadId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

/** Minimal fake req/res to drive handleWebhooks without a live server. */
function fakeReqRes(path: string, rawBody: string, headers: Record<string, string>) {
  const rawHeaders = Object.entries(headers).flat();
  const req = {
    method: "POST",
    url: path,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawHeaders,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawBody);
    },
  } as unknown as IncomingMessage;

  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body = chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;

  return { req, res, captured };
}

async function post(adapter: string, body: unknown, headers: Record<string, string>) {
  const path = `/api/integrations/chat/${adapter}/webhook`;
  const { req, res, captured } = fakeReqRes(path, JSON.stringify(body), {
    "Content-Type": "application/json",
    ...headers,
  });
  const handled = await handleWebhooks(req, res, path.split("/").filter(Boolean));
  expect(handled).toBe(true);
  return captured;
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const lead = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatLead",
    isLead: true,
    status: "idle",
  });
  leadId = lead.id;
  mock = startTelegramBotApiMock();
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
    telegram: { botToken: "t", secretToken: SECRET, mode: "webhook" },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({ telegram: mock.url });
  await startChatSdk();
});

afterAll(async () => {
  await stopChatSdk();
  mock.stop();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  await removeDbFiles();
});

describe("Chat SDK Telegram webhook", () => {
  test("the adapter starts healthy against the mock Bot API", () => {
    expect(getChatSdkHealth().telegram?.status).toBe("ok");
    expect(mock.calls.some((call) => call.method === "getMe")).toBe(true);
  });

  test("a wrong secret token is rejected with 401", async () => {
    const captured = await post("telegram", privateText, {
      "X-Telegram-Bot-Api-Secret-Token": "wrong",
    });
    expect(captured.status).toBe(401);
  });

  test("a body above 1 MiB is rejected with 413 before the adapter runs", async () => {
    const path = "/api/integrations/chat/telegram/webhook";
    const segments = path.split("/").filter(Boolean);
    const oversized = "x".repeat(1024 * 1024 + 1);
    const secretHeader = { "X-Telegram-Bot-Api-Secret-Token": SECRET };
    const sentBefore = mock.calls.length;

    // Declared up front: rejected before any chunk is read.
    const declared = fakeReqRes(path, "{}", {
      ...secretHeader,
      "Content-Length": String(oversized.length),
    });
    expect(await handleWebhooks(declared.req, declared.res, segments)).toBe(true);
    expect(declared.captured.status).toBe(413);

    // Streamed without Content-Length: rejected once the cap is crossed.
    const streamed = fakeReqRes(path, oversized, secretHeader);
    expect(await handleWebhooks(streamed.req, streamed.res, segments)).toBe(true);
    expect(streamed.captured.status).toBe(413);
    expect(JSON.parse(streamed.captured.body).error).toContain("Payload too large");
    expect(mock.calls.length).toBe(sentBefore);
  });

  test("an unconfigured adapter answers 404", async () => {
    const captured = await post("discord", {}, {});
    expect(captured.status).toBe(404);
  });

  test("a private-chat text update creates one Lead task with a chat-sdk contextKey", async () => {
    const captured = await post("telegram", privateText, {
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    });
    expect(captured.status).toBe(200);
    expect(await drainBackground(5_000)).toBe(true);
    // Messages wait in the thread buffer; flush it instead of waiting 10 s.
    await flushAllChatBuffers();
    expect(await drainBackground(5_000)).toBe(true);

    const tasks = await getDbClient().query<{
      id: string;
      source: string;
      contextKey: string;
      agentId: string | null;
      task: string;
      taskType: string;
    }>(
      "SELECT id, source, contextKey, agentId, task, taskType FROM agent_tasks WHERE source = 'chat'",
    );
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task!.contextKey.startsWith("task:chat-sdk:telegram:")).toBe(true);
    expect(task!.agentId).toBe(leadId);
    expect(task!.taskType).toBe("chat-inbound");
    expect(task!.task).toContain("summarize the open tasks");

    const subscriptions = await getDbClient().query<{ thread_id: string }>(
      "SELECT thread_id FROM chat_subscriptions",
    );
    expect(subscriptions.map((row) => row.thread_id)).toContain("telegram:555001");
  });

  test("a redelivered update is deduplicated", async () => {
    const captured = await post("telegram", privateText, {
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    });
    expect(captured.status).toBe(200);
    expect(await drainBackground(5_000)).toBe(true);
    await flushAllChatBuffers();
    const row = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE source = 'chat'",
    );
    expect(row?.n).toBe(1);
  });
});

describe("chat-sdk capability", () => {
  test("is advertised only when CHAT_SDK_ENABLED is true", () => {
    const previous = process.env.CHAT_SDK_ENABLED;
    try {
      process.env.CHAT_SDK_ENABLED = "true";
      expect(getEnabledCapabilities()).toContain("chat-sdk");
      process.env.CHAT_SDK_ENABLED = "false";
      expect(getEnabledCapabilities()).not.toContain("chat-sdk");
    } finally {
      if (previous === undefined) delete process.env.CHAT_SDK_ENABLED;
      else process.env.CHAT_SDK_ENABLED = previous;
    }
  });
});
