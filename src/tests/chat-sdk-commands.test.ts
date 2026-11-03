import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { Message, parseMarkdown, toPlainText } from "chat";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import {
  CHAT_COMMANDS,
  getChatThreadResetAt,
  runChatCommand,
} from "../integrations/chat-sdk/commands";
import { chatMessageText } from "../integrations/chat-sdk/message-text";
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

describe("Chat SDK commands on a channel-keyed platform (Discord)", () => {
  // A Discord mention opens a thread: its tasks are keyed `guild:channel:thread`,
  // while a slash command in the parent channel only knows `guild:channel`.
  const channel = "discord:G1:C1";
  const olderThread = "discord:G1:C1:T-old";
  const newerThread = "discord:G1:C1:T-new";
  let olderId: string;
  let newerId: string;
  /** Owns both threads. */
  let ownerId: string;
  /** Another member of the channel. */
  let otherId: string;
  const asOwner = (command: string, thread = channel) =>
    runChatCommand(command, thread, "owner", ownerId);
  const asOther = (command: string) => runChatCommand(command, channel, "other", otherId);

  beforeAll(async () => {
    ownerId = (await createUser({ name: "Owner" })).id;
    otherId = (await createUser({ name: "Other" })).id;
    const agent = await createAgent({
      id: crypto.randomUUID(),
      name: "DiscordCmdWorker",
      isLead: false,
      status: "idle",
    });
    const seed = async (thread: string, text: string) =>
      (
        await createTaskExtended(text, {
          agentId: agent.id,
          source: "chat",
          contextKey: chatSdkContextKey(thread),
          requestedByUserId: ownerId,
        })
      ).id;
    olderId = await seed(olderThread, "older thread ask");
    await Bun.sleep(5);
    newerId = await seed(newerThread, "newer thread ask");
    // A task in another channel whose id merely starts with this channel's.
    await seed("discord:G1:C10:T-x", "another channel");
  });

  test("/status in the channel reports the sender's most recent thread task", async () => {
    const reply = await asOwner("/status");
    expect(reply).toContain(newerId.slice(0, 8));
    expect(reply).not.toContain("No task yet");
  });

  test("/status inside a thread reports that thread", async () => {
    expect(await asOwner("/status", olderThread)).toContain(olderId.slice(0, 8));
  });

  test("another user's channel-level commands never reach the owner's threads", async () => {
    // The threads may be private: neither the task ids nor their state leak.
    expect(await asOther("/status")).toContain("No task yet");
    await asOther("/reset");
    expect(await getChatThreadResetAt(newerThread)).toBeNull();
    expect(await getChatThreadResetAt(olderThread)).toBeNull();
    expect(await asOther("/cancel")).toContain("No running task");
    // An unknown sender gets no cross-thread target either.
    expect(await runChatCommand("/cancel", channel, "stranger")).toContain("No running task");
    expect((await getTaskById(newerId))?.status).toBe("pending");
    expect((await getTaskById(olderId))?.status).toBe("pending");
  });

  test("/cancel in the channel cancels the most recent running thread, one at a time", async () => {
    expect(await asOwner("/cancel")).toContain(`Cancelled task ${newerId.slice(0, 8)}`);
    expect((await getTaskById(olderId))?.status).toBe("pending");
    expect(await asOwner("/cancel")).toContain(`Cancelled task ${olderId.slice(0, 8)}`);
    // Neither the task of C10 nor any other channel counts.
    expect(await asOwner("/cancel")).toContain("No running task");
  });
});

describe("chatMessageText", () => {
  const message = (markdown: string) => {
    const formatted = parseMarkdown(markdown);
    return new Message({
      id: "m1",
      threadId: "discord:G1:C1",
      text: toPlainText(formatted),
      formatted,
      raw: {},
      author: { userId: "u1", userName: "u", fullName: "U", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
    });
  };

  test("keeps link URLs, code and emphasis that the plain text drops", () => {
    const m = message(
      "see [docs](https://example.com/a?b=1) and `bun test`\n\n```ts\nlet x = 1;\n```",
    );
    expect(m.text).not.toContain("https://example.com");
    const text = chatMessageText(m);
    expect(text).toContain("[docs](https://example.com/a?b=1)");
    expect(text).toContain("`bun test`");
    expect(text).toContain("```ts\nlet x = 1;\n```");
  });

  test("plain text stays as typed", () => {
    expect(chatMessageText(message("just a plain request"))).toBe("just a plain request");
  });

  test("falls back to the plain text when there is no AST", () => {
    expect(chatMessageText({ text: "fallback text", formatted: undefined as never })).toBe(
      "fallback text",
    );
  });
});

describe("chatMessageText fidelity", () => {
  const textOf = (markdown: string) => {
    const formatted = parseMarkdown(markdown);
    return chatMessageText({ text: toPlainText(formatted), formatted });
  };

  test("does not escape underscores, brackets or mention names", () => {
    expect(textOf("@swarm_test_bot !now fix snake_case_name in [x]")).toBe(
      "@swarm_test_bot !now fix snake_case_name in [x]",
    );
  });

  test("keeps emphasis, lists, quotes and a code span with a backtick", () => {
    const text = textOf("**bold** and _soft_\n\n- one\n- two\n  - nested\n\n> quoted\n\n``a`b``");
    expect(text).toContain("**bold** and _soft_");
    expect(text).toContain("- one\n- two\n  - nested");
    expect(text).toContain("> quoted");
    expect(text).toContain("``a`b``");
  });

  test("an autolink stays a bare URL", () => {
    expect(textOf("see https://example.com/x now")).toBe("see https://example.com/x now");
  });
});
