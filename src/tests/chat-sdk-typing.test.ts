import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, completeTask, createAgent, getDbClient, initDb } from "../be/db";
import { processPendingChatRelays, stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { setChatSdkTestHooks } from "../integrations/chat-sdk/test-hooks";
import { stopAllTypingKeepalives } from "../integrations/chat-sdk/typing";
import { chatSdkContextKey } from "../tasks/context-key";
import {
  flushChatBuffers,
  postTelegramUpdate,
  startTelegramHarness,
  type TelegramHarness,
  telegramUpdate,
} from "./chat-sdk-harness";

const TEST_DB_PATH = "./test-chat-sdk-typing.sqlite";
const TYPING_INTERVAL_MS = 50;

let harness: TelegramHarness;
let nextChatId = 990_000;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

function typingCalls(chatId: number): number {
  return harness.mock.calls.filter(
    (call) =>
      call.method === "sendChatAction" &&
      String((call.body as Record<string, unknown>).chat_id) === String(chatId),
  ).length;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await createAgent({
    id: crypto.randomUUID(),
    name: "ChatTypingLead",
    isLead: true,
    status: "idle",
  });
  harness = await startTelegramHarness();
  // Relay ticks are driven by the tests.
  await stopChatRelayWatcher();
});

afterAll(async () => {
  stopAllTypingKeepalives();
  setChatSdkTestHooks({});
  await harness.stop();
  closeDb();
  await removeDbFiles();
});

afterEach(() => {
  stopAllTypingKeepalives();
  setChatSdkTestHooks({});
});

describe("Chat SDK typing keepalive", () => {
  // Timing-sensitive: counts real-timer renewals over a short window.
  test(
    "a buffered DM keeps sending the typing action",
    async () => {
      setChatSdkTestHooks({ typingIntervalMs: TYPING_INTERVAL_MS });
      const chatId = ++nextChatId;
      await postTelegramUpdate(telegramUpdate({ id: chatId, type: "private" }, "hello"));
      await wait(TYPING_INTERVAL_MS * 6);
      // The adapter sends one action on arrival; the keepalive adds the rest.
      expect(typingCalls(chatId)).toBeGreaterThan(2);
    },
    { retry: 2 },
  );

  // Timing-sensitive: asserts that no renewal arrives after the relay.
  test(
    "the relay of the task output stops the typing action",
    async () => {
      setChatSdkTestHooks({ typingIntervalMs: TYPING_INTERVAL_MS });
      const chatId = ++nextChatId;
      await postTelegramUpdate(telegramUpdate({ id: chatId, type: "private" }, "do the thing"));
      await flushChatBuffers();
      const task = await getDbClient().get<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE contextKey = ?",
        [chatSdkContextKey(`telegram:${chatId}`)],
      );
      expect(task).toBeTruthy();
      await completeTask(task!.id, "Done.");
      await processPendingChatRelays();
      // Let a renewal that was already in flight land.
      await wait(TYPING_INTERVAL_MS * 2);
      const afterRelay = typingCalls(chatId);
      expect(afterRelay).toBeGreaterThan(1);
      await wait(TYPING_INTERVAL_MS * 6);
      expect(typingCalls(chatId)).toBe(afterRelay);
    },
    { retry: 2 },
  );

  // Timing-sensitive: waits past a shortened hard cap.
  test(
    "the hard cap stops the typing action",
    async () => {
      setChatSdkTestHooks({ typingIntervalMs: TYPING_INTERVAL_MS, typingMaxMs: 200 });
      const chatId = ++nextChatId;
      await postTelegramUpdate(telegramUpdate({ id: chatId, type: "private" }, "slow request"));
      await wait(400);
      const afterCap = typingCalls(chatId);
      expect(afterCap).toBeGreaterThan(1);
      await wait(TYPING_INTERVAL_MS * 6);
      expect(typingCalls(chatId)).toBe(afterCap);
    },
    { retry: 2 },
  );
});
