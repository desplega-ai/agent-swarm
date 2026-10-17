import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, getTaskById, initDb } from "../be/db";
import { CHAT_COMMANDS } from "../integrations/chat-sdk/commands";
import { startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { readPersistedThreadHistory } from "../integrations/chat-sdk/state";
import { chatSdkContextKey } from "../tasks/context-key";
import {
  flushChatBuffers,
  postTelegramUpdate,
  startTelegramHarness,
  type TelegramChat,
  type TelegramHarness,
  telegramUpdate,
} from "./chat-sdk-harness";

const TEST_DB_PATH = "./test-chat-sdk-commands.sqlite";

let harness: TelegramHarness;

type TaskRow = { id: string; task: string; status: string; parentTaskId: string | null };

async function chatTasks(chatId: number): Promise<TaskRow[]> {
  return getDbClient().query<TaskRow>(
    `SELECT id, task, status, parentTaskId FROM agent_tasks
       WHERE source = 'chat' AND contextKey = ? ORDER BY createdAt, rowid`,
    [chatSdkContextKey(`telegram:${chatId}`)],
  );
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

const dm = (id: number): TelegramChat => ({ id, type: "private" });

/** A `/command` update: Telegram marks the command with a `bot_command` entity at offset 0. */
function commandUpdate(chat: TelegramChat, command: string): Record<string, unknown> {
  return telegramUpdate(chat, command, {
    entities: [{ type: "bot_command", offset: 0, length: command.length }],
  });
}

/** Text of every message the bot sent to `chatId`, in order. */
function sentTexts(chatId: number): string[] {
  return harness.mock.calls
    .filter((call) => /^send(Rich)?Message$/.test(call.method))
    .filter((call) => String(call.body.chat_id) === String(chatId))
    .map((call) => {
      const rich = call.body.rich_message as { markdown?: string } | undefined;
      return String(call.body.text ?? rich?.markdown ?? "");
    });
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await createAgent({ id: crypto.randomUUID(), name: "CmdLead", isLead: true, status: "idle" });
  harness = await startTelegramHarness();
});

afterAll(async () => {
  await harness.stop();
  closeDb();
  await removeDbFiles();
});

describe("Chat SDK slash commands", () => {
  test("the command list is published to Telegram at adapter start", () => {
    const call = harness.mock.calls.find((c) => c.method === "setMyCommands");
    expect(call).toBeDefined();
    const names = (call!.body.commands as { command: string }[]).map((c) => c.command);
    expect(names).toEqual(CHAT_COMMANDS.map((c) => c.command));
  });

  test("/help answers with the list and creates no task", async () => {
    await postTelegramUpdate(commandUpdate(dm(3001), "/help"));
    const texts = sentTexts(3001);
    expect(texts).toHaveLength(1);
    for (const spec of CHAT_COMMANDS) expect(texts[0]).toContain(`/${spec.command}`);
    await flushChatBuffers();
    expect(await chatTasks(3001)).toHaveLength(0);
  });

  test("/start in a fresh DM answers with the welcome and stays out of the / menu", async () => {
    await postTelegramUpdate(commandUpdate(dm(3003), "/start"));
    const texts = sentTexts(3003);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Each answer arrives as a reply to your message.");
    expect(texts[0]).toContain("/help");
    expect(texts[0]).not.toContain("Unknown command");
    expect(CHAT_COMMANDS.map((c) => c.command)).not.toContain("start");
    await flushChatBuffers();
    expect(await chatTasks(3003)).toHaveLength(0);
  });

  test("an unknown command gets the list instead of silence", async () => {
    await postTelegramUpdate(commandUpdate(dm(3002), "/deploy"));
    const texts = sentTexts(3002);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Unknown command /deploy");
    expect(texts[0]).toContain("/help");
    await flushChatBuffers();
    expect(await chatTasks(3002)).toHaveLength(0);
  });

  test("/status reports the latest task and /cancel cancels the active one", async () => {
    await postTelegramUpdate(commandUpdate(dm(3003), "/status"));
    expect(sentTexts(3003).at(-1)).toContain("No task yet");

    await postTelegramUpdate(telegramUpdate(dm(3003), "please look into the build"));
    await flushChatBuffers();
    const [task] = await chatTasks(3003);
    expect(task).toBeDefined();
    expect(task!.status).toBe("pending");

    await postTelegramUpdate(commandUpdate(dm(3003), "/status"));
    const status = sentTexts(3003).at(-1)!;
    expect(status).toContain(task!.id.slice(0, 8));
    expect(status).toContain("pending");
    expect(status).toContain("/cancel");

    await postTelegramUpdate(commandUpdate(dm(3003), "/cancel"));
    expect(sentTexts(3003).at(-1)).toContain(`Cancelled task ${task!.id.slice(0, 8)}`);
    const cancelled = await getTaskById(task!.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.failureReason).toContain("Cancelled from chat by tester");

    await postTelegramUpdate(commandUpdate(dm(3003), "/cancel"));
    expect(sentTexts(3003).at(-1)).toContain("No running task");
  });

  test("/reset starts a new conversation: no parent task and no older context", async () => {
    await postTelegramUpdate(telegramUpdate(dm(3004), "the first request"));
    await flushChatBuffers();
    await postTelegramUpdate(telegramUpdate(dm(3004), "a follow-up"));
    await flushChatBuffers();
    let tasks = await chatTasks(3004);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.parentTaskId).toBe(tasks[0]!.id);
    expect(tasks[1]!.task).toContain("<thread_context>");
    expect(tasks[1]!.task).toContain("the first request");

    // Reset while a task still runs: the mark is set, and the reply says so.
    await postTelegramUpdate(commandUpdate(dm(3004), "/reset"));
    expect(sentTexts(3004).at(-1)).toContain("Context reset");
    expect(sentTexts(3004).at(-1)).toContain("still running");

    // The usual case: the thread's tasks are done when the user resets.
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE contextKey = ?", [
      chatSdkContextKey("telegram:3004"),
    ]);
    await postTelegramUpdate(commandUpdate(dm(3004), "/reset"));
    expect(sentTexts(3004).at(-1)).not.toContain("still running");
    // The reset mark is compared to message timestamps with second precision.
    await Bun.sleep(1_100);

    await postTelegramUpdate(telegramUpdate(dm(3004), "a brand new topic"));
    await flushChatBuffers();
    tasks = await chatTasks(3004);
    expect(tasks).toHaveLength(3);
    expect(tasks[2]!.parentTaskId).toBeNull();
    expect(tasks[2]!.task).not.toContain("<thread_context>");
    expect(tasks[2]!.task).not.toContain("the first request");

    await postTelegramUpdate(telegramUpdate(dm(3004), "more on the new topic"));
    await flushChatBuffers();
    tasks = await chatTasks(3004);
    expect(tasks).toHaveLength(4);
    expect(tasks[3]!.parentTaskId).toBe(tasks[2]!.id);
    expect(tasks[3]!.task).toContain("a brand new topic");
    expect(tasks[3]!.task).not.toContain("the first request");
    expect(tasks[3]!.task).not.toContain("a follow-up");
  });
});

describe("Chat SDK thread context across an adapter restart", () => {
  test("the SDK persists Telegram history under the pinned key prefix", async () => {
    await postTelegramUpdate(telegramUpdate(dm(3005), "remember this one"));
    await flushChatBuffers();
    const history = await readPersistedThreadHistory("telegram:3005");
    expect(history.map((m) => m.text)).toContain("remember this one");
  });

  test("a message after a restart still carries the earlier thread messages", async () => {
    await postTelegramUpdate(telegramUpdate(dm(3006), "before the restart"));
    await flushChatBuffers();

    // Same as a config reload or an API restart: the adapter's memory is gone.
    await stopChatSdk();
    await startChatSdk();

    await postTelegramUpdate(telegramUpdate(dm(3006), "after the restart"));
    await flushChatBuffers();
    const tasks = await chatTasks(3006);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.parentTaskId).toBe(tasks[0]!.id);
    expect(tasks[1]!.task).toContain("<thread_context>");
    expect(tasks[1]!.task).toContain("before the restart");
  });
});
