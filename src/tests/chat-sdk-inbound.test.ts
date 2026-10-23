import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  createUser,
  getDbClient,
  getKv,
  getTaskAttachments,
  getTaskById,
  initDb,
  startTask,
  upsertKv,
} from "../be/db";
import { linkIdentity } from "../be/users";
import { resetFileStorageProviderForTests } from "../fs/registry";
import { drainBackground } from "../integrations/chat-sdk/background";
import { CHAT_CHANNEL_SETTINGS_NAMESPACE } from "../integrations/chat-sdk/reactions";
import { formatChatRelayText, formatChatTaskTag } from "../integrations/chat-sdk/relay";
import { CHAT_CHANNELS_NAMESPACE, routeChatMessage } from "../integrations/chat-sdk/router";
import { getChatInstance } from "../integrations/chat-sdk/runtime";
import { isChatThreadBuffered } from "../integrations/chat-sdk/thread-buffer";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { chatSdkContextKey } from "../tasks/context-key";
import { registerDeferTaskTool } from "../tools/defer-task";
import type { Agent } from "../types";
import { NOT_TRANSCRIBED_NOTE, TRANSCRIPTION_ENV_KEYS } from "../utils/transcription";
import {
  flushChatBuffers,
  postChatWebhook,
  postTelegramUpdate,
  startTelegramHarness,
  TELEGRAM_SECRET,
  type TelegramChat,
  type TelegramHarness,
  telegramUpdate,
} from "./chat-sdk-harness";

const TEST_DB_PATH = "./test-chat-sdk-inbound.sqlite";
const ENV_KEYS = [
  "AGENT_FS_LOCAL_DIR",
  "AGENT_FS_API_URL",
  "STEERING_ENABLED",
  "TELEGRAM_MENTION_ON_REPLY",
  "CHAT_SDK_OWNER_WINDOW_MIN",
  ...TRANSCRIPTION_ENV_KEYS,
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let harness: TelegramHarness;
let lead: Agent;
let worker: Agent;
let fsDir: string;
/** `ctx.skipped` length seen by every DM / subscribed delivery (always 0 under `concurrent`). */
const skippedCounts: number[] = [];

type TaskRow = {
  id: string;
  agentId: string | null;
  task: string;
  status: string;
  routingReason: string | null;
};

async function chatTasks(chatId: number): Promise<TaskRow[]> {
  return getDbClient().query<TaskRow>(
    `SELECT id, agentId, task, status, routing_reason AS routingReason FROM agent_tasks
       WHERE source = 'chat' AND contextKey = ? ORDER BY createdAt, rowid`,
    [chatSdkContextKey(`telegram:${chatId}`)],
  );
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

beforeAll(async () => {
  await removeDbFiles();
  fsDir = await mkdtemp(join(tmpdir(), "chat-sdk-inbound-fs-"));
  process.env.AGENT_FS_LOCAL_DIR = fsDir;
  delete process.env.AGENT_FS_API_URL;
  process.env.STEERING_ENABLED = "true";
  // The adapter must treat a reply to the bot as a mention without the env fallback.
  delete process.env.TELEGRAM_MENTION_ON_REPLY;
  delete process.env.CHAT_SDK_OWNER_WINDOW_MIN;
  // A provider key in the shell (OPENAI_API_KEY, ...) would switch transcription on.
  for (const key of TRANSCRIPTION_ENV_KEYS) delete process.env[key];
  resetFileStorageProviderForTests();
  initDb(TEST_DB_PATH);
  lead = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatInboundLead",
    isLead: true,
    status: "idle",
  });
  worker = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatInboundWorker",
    isLead: false,
    status: "idle",
  });
  harness = await startTelegramHarness();
  const chat = getChatInstance("telegram");
  expect(chat).toBeDefined();
  chat!.onDirectMessage((_thread, _message, _channel, ctx) => {
    skippedCounts.push(ctx?.skipped?.length ?? 0);
  });
  chat!.onSubscribedMessage((_thread, _message, ctx) => {
    skippedCounts.push(ctx?.skipped?.length ?? 0);
  });
});

afterAll(async () => {
  await harness.stop();
  closeDb();
  await removeDbFiles();
  await rm(fsDir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetFileStorageProviderForTests();
});

beforeEach(() => {
  process.env.CHAT_SDK_BUFFER_MS = "60000";
});

type DeferTaskTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

function buildDeferTaskTool(): DeferTaskTool {
  const server = new McpServer({ name: "chat-sdk-inbound-test", version: "1.0.0" });
  registerDeferTaskTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, DeferTaskTool> })
    ._registeredTools;
  return tools["defer-task"]!;
}

const dm = (id: number): TelegramChat => ({ id, type: "private" });
const group = (id: number): TelegramChat => ({ id, type: "group" });

const messageIdOf = (update: Record<string, unknown>) =>
  (update.message as { message_id: number }).message_id;

/** Every `setMessageReaction` call on one message, as the emoji it set (`""` = cleared). */
function reactionsOn(chatId: number, update: Record<string, unknown>): string[] {
  return harness.mock.calls
    .filter((call) => call.method === "setMessageReaction")
    .map((call) => call.body as { chat_id: unknown; message_id: unknown; reaction: unknown })
    .filter(
      (body) =>
        String(body.chat_id) === String(chatId) && Number(body.message_id) === messageIdOf(update),
    )
    .map((body) => {
      const reaction =
        typeof body.reaction === "string" ? JSON.parse(body.reaction) : body.reaction;
      return (reaction as Array<{ emoji?: string }>).map((r) => r.emoji ?? "").join("");
    });
}

describe("Chat SDK inbound pipeline", () => {
  test("two messages inside the buffer window become one task", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2001), "first part of the request"));
    await postTelegramUpdate(telegramUpdate(dm(2001), "second part of the request"));
    expect(await chatTasks(2001)).toHaveLength(0);

    await flushChatBuffers();
    const tasks = await chatTasks(2001);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toContain("[Thread follow-up: 2 message(s) buffered]");
    expect(tasks[0]!.task).toContain("first part of the request");
    expect(tasks[0]!.task).toContain("second part of the request");
    expect(tasks[0]!.agentId).toBe(lead.id);
    // `concurrent` never batches deliveries, so the SDK skips nothing.
    expect(skippedCounts.length).toBeGreaterThanOrEqual(2);
    expect(skippedCounts.every((count) => count === 0)).toBe(true);
  });

  test("!now flushes the thread at once", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2002), "!now ship the hotfix"));
    const tasks = await chatTasks(2002);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toEndWith("\n\nship the hotfix");
  });

  test("swarm#<uuid> routes to that agent", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2003), `swarm#${worker.id} build the parser`));
    await flushChatBuffers();
    const tasks = await chatTasks(2003);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(worker.id);
    expect(tasks[0]!.task).toEndWith("\n\nbuild the parser");
  });

  test("a KV channel mapping routes to the pinned agent", async () => {
    await upsertKv({
      namespace: CHAT_CHANNELS_NAMESPACE,
      key: "telegram:2004",
      value: { agentId: worker.id },
      valueType: "json",
    });
    await postTelegramUpdate(telegramUpdate(dm(2004), "summarize the logs"));
    await flushChatBuffers();
    const tasks = await chatTasks(2004);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(worker.id);
    expect(tasks[0]!.routingReason).toBe("human_pinned");
  });

  test("a workflow channel mapping fires only for a mention or DM, not a subscribed reply", async () => {
    await upsertKv({
      namespace: CHAT_CHANNELS_NAMESPACE,
      key: "telegram:-2008",
      value: { workflowId: "wf-mapped" },
      valueType: "json",
    });
    const ctx = {
      adapter: "telegram" as const,
      channelId: "telegram:-2008",
      threadId: "telegram:-2008",
    };
    expect(
      await routeChatMessage("run it", { ...ctx, botMentioned: true, isDirectMessage: false }),
    ).toEqual({ kind: "workflow", workflowId: "wf-mapped" });
    expect(
      await routeChatMessage("run it", { ...ctx, botMentioned: false, isDirectMessage: true }),
    ).toEqual({ kind: "workflow", workflowId: "wf-mapped" });
    // A plain reply in the subscribed thread after the first run: no owner, no mention.
    expect(
      await routeChatMessage("thanks", { ...ctx, botMentioned: false, isDirectMessage: false }),
    ).toBeNull();
  });

  async function steeringRows(taskId: string) {
    return getDbClient().query<{ body: string; source: string }>(
      "SELECT body, source FROM task_steering_messages WHERE task_id = ?",
      [taskId],
    );
  }

  test("a group reply to an in-progress lead task steers it instead of creating a task", async () => {
    await postTelegramUpdate(telegramUpdate(group(-2005), "@swarm_test_bot draft the report"));
    await flushChatBuffers();
    const [first] = await chatTasks(-2005);
    expect(first?.agentId).toBe(lead.id);
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);

    const sendCount = () =>
      harness.mock.calls.filter((call) => /^send(Rich)?Message$/.test(call.method)).length;
    const sendsBefore = sendCount();
    const steer = telegramUpdate(group(-2005), "also add the charts");
    await postTelegramUpdate(steer);
    await flushChatBuffers();

    expect(await chatTasks(-2005)).toHaveLength(1);
    expect(await steeringRows(first!.id)).toEqual([
      { body: "also add the charts", source: "chat" },
    ]);
    // A reaction acknowledges the steering message; no text reply.
    expect(reactionsOn(-2005, steer)).toEqual(["✍"]);
    expect(sendCount()).toBe(sendsBefore);
  });

  test("a channel that opts into text acks also gets the steering reply", async () => {
    await upsertKv({
      namespace: CHAT_CHANNEL_SETTINGS_NAMESPACE,
      key: "telegram:-2015",
      value: { textAcks: true },
      valueType: "json",
    });
    await postTelegramUpdate(telegramUpdate(group(-2015), "@swarm_test_bot draft the report"));
    await flushChatBuffers();
    const [first] = await chatTasks(-2015);
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);

    const steer = telegramUpdate(group(-2015), "also add the charts");
    await postTelegramUpdate(steer);

    expect(reactionsOn(-2015, steer)).toEqual(["✍"]);
    const sends = harness.mock.calls.filter((call) => /^send(Rich)?Message$/.test(call.method));
    // The acknowledgement replies to the steering message.
    expect(sends.at(-1)?.body.reply_parameters).toEqual({
      message_id: messageIdOf(steer),
      allow_sending_without_reply: true,
    });
  });

  test("an ask gets one reaction at a time; earlier buffered messages are cleared at flush", async () => {
    const firstPart = telegramUpdate(dm(2016), "first part");
    const secondPart = telegramUpdate(dm(2016), "second part");
    await postTelegramUpdate(firstPart);
    expect(reactionsOn(2016, firstPart)).toEqual(["👀"]);
    await postTelegramUpdate(secondPart);
    await flushChatBuffers();

    expect(await chatTasks(2016)).toHaveLength(1);
    // The task answers the newest message, which keeps 👀; the earlier one is cleared.
    expect(reactionsOn(2016, secondPart)).toEqual(["👀"]);
    expect(reactionsOn(2016, firstPart)).toEqual(["👀", ""]);

    const quick = telegramUpdate(dm(2017), "!now ship it");
    await postTelegramUpdate(quick);
    expect(reactionsOn(2017, quick)).toEqual(["⚡"]);
  });

  test("a REACTION_INVALID answer is logged and the ask still becomes a task", async () => {
    const warn = spyOn(console, "warn");
    harness.mock.failReactions(1);
    try {
      const ask = telegramUpdate(dm(2018), "!now plan the sprint");
      await postTelegramUpdate(ask);
      expect(await chatTasks(2018)).toHaveLength(1);
      expect(reactionsOn(2018, ask)).toHaveLength(1);
      expect(
        warn.mock.calls.some((args) => String(args[0]).includes("Could not set the now reaction")),
      ).toBe(true);
    } finally {
      harness.mock.failReactions(0);
      warn.mockRestore();
    }
  });

  test("a mention in a subscribed group gets 👀 before the flush, and the flush does not react again", async () => {
    await postTelegramUpdate(telegramUpdate(group(-2991), "@swarm_test_bot first ask"));
    await flushChatBuffers();
    const ask = telegramUpdate(group(-2991), "@swarm_test_bot second ask");
    await postTelegramUpdate(ask);
    expect(reactionsOn(-2991, ask)).toEqual(["👀"]);
    await flushChatBuffers();
    expect(await chatTasks(-2991)).toHaveLength(2);
    expect(reactionsOn(-2991, ask)).toEqual(["👀"]);
  });

  test("a !now mention in a subscribed group gets ⚡, not 👀", async () => {
    await postTelegramUpdate(telegramUpdate(group(-2992), "@swarm_test_bot first ask"));
    await flushChatBuffers();
    const ask = telegramUpdate(group(-2992), "@swarm_test_bot !now second ask");
    await postTelegramUpdate(ask);
    expect(await chatTasks(-2992)).toHaveLength(2);
    expect(reactionsOn(-2992, ask)).toEqual(["⚡"]);
  });

  test("two asks back to back each anchor to their own message, not the parent's", async () => {
    const firstAsk = telegramUpdate(group(-2010), "@swarm_test_bot !now summarize the PR");
    await postTelegramUpdate(firstAsk);
    const secondAsk = telegramUpdate(group(-2010), "@swarm_test_bot !now and list the risks");
    await postTelegramUpdate(secondAsk);
    await flushChatBuffers();

    const rows = await chatTasks(-2010);
    expect(rows).toHaveLength(2);
    const [first, second] = await Promise.all(rows.map((row) => getTaskById(row.id)));
    const idOf = (update: Record<string, unknown>) =>
      `-2010:${(update.message as { message_id: number }).message_id}`;
    expect(first?.mentionMessageId).toBe(idOf(firstAsk));
    // The second task is a child of the first; `createTask` would copy the
    // parent's anchor if inbound did not set its own.
    expect(second?.parentTaskId).toBe(first!.id);
    expect(second?.mentionMessageId).toBe(idOf(secondAsk));
    expect(second?.mentionChannelId).toBeTruthy();
  });

  test("a Telegram private-chat DM steers too (DMs never reach onSubscribedMessage)", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2006), "start the migration"));
    await flushChatBuffers();
    const [first] = await chatTasks(2006);
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);

    await postTelegramUpdate(telegramUpdate(dm(2006), "skip the staging step"));
    await flushChatBuffers();

    expect(await chatTasks(2006)).toHaveLength(1);
    expect(await steeringRows(first!.id)).toEqual([
      { body: "skip the staging step", source: "chat" },
    ]);
  });

  test("a reply while the task is still pending becomes a follow-up that depends on it", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2007), "plan the release"));
    await flushChatBuffers();
    const [first] = await chatTasks(2007);
    expect(first?.status).toBe("pending");

    await postTelegramUpdate(telegramUpdate(dm(2007), "include the changelog"));
    await flushChatBuffers();

    const tasks = await chatTasks(2007);
    expect(tasks).toHaveLength(2);
    const followUp = await getTaskById(tasks[1]!.id);
    expect(followUp?.dependsOn).toEqual([first!.id]);
    expect(followUp?.parentTaskId).toBe(first!.id);
    expect(followUp?.task).toContain("include the changelog");
  });

  test("a deferred wake-up is the thread's chat task: steering, a follow-up dependency and /cancel reach it", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2040), "check the deploy"));
    await flushChatBuffers();
    const [first] = await chatTasks(2040);
    await completeTask(first!.id, "Deferred.", { deferredAt: new Date().toISOString() });
    const schedule = await createScheduledTask({
      name: `deferred-${first!.id.slice(0, 8)}-${crypto.randomUUID()}`,
      taskTemplate: "Check the deploy and answer.",
      targetType: "agent-task",
      scheduleType: "one_time",
      nextRunAt: new Date().toISOString(),
      targetAgentId: lead.id,
      createdByAgentId: lead.id,
      taskType: "deferred",
      parentTaskId: first!.id,
    });
    const wakeUp = await createStandaloneScheduleTask(schedule);
    expect(wakeUp.source).toBe("schedule");
    expect(wakeUp.contextKey).toBe(chatSdkContextKey("telegram:2040"));

    // In progress: a plain message steers the wake-up.
    await startTask(wakeUp.id);
    await postTelegramUpdate(telegramUpdate(dm(2040), "use the staging cluster"));
    await flushChatBuffers();
    expect(await chatTasks(2040)).toHaveLength(1);
    expect(await steeringRows(wakeUp.id)).toEqual([
      { body: "use the staging cluster", source: "chat" },
    ]);

    // Pending: a new message becomes a follow-up that waits for it.
    await getDbClient().run("UPDATE agent_tasks SET status = 'pending' WHERE id = ?", [wakeUp.id]);
    await postTelegramUpdate(telegramUpdate(dm(2040), "and the canary"));
    await flushChatBuffers();
    const tasks = await chatTasks(2040);
    expect(tasks).toHaveLength(2);
    expect((await getTaskById(tasks[1]!.id))?.dependsOn).toEqual([wakeUp.id]);

    // /cancel stops the follow-up and the wake-up.
    const cancel = telegramUpdate(dm(2040), "/cancel", {
      entities: [{ type: "bot_command", offset: 0, length: "/cancel".length }],
    });
    await postTelegramUpdate(cancel);
    expect((await getTaskById(wakeUp.id))?.status).toBe("cancelled");
    expect((await getTaskById(tasks[1]!.id))?.status).toBe("cancelled");
  });

  test("a document attachment becomes a task attachment and a [File: ...] line", async () => {
    const bytes = new TextEncoder().encode("meeting notes\n");
    harness.mock.addFile("documents/notes.txt", bytes);
    await postTelegramUpdate(
      telegramUpdate(dm(2008), "", {
        caption: "see the attached notes",
        document: {
          file_id: "documents/notes.txt",
          file_unique_id: "notes-unique",
          file_name: "notes.txt",
          mime_type: "text/plain",
          file_size: bytes.byteLength,
        },
      }),
    );
    await flushChatBuffers();

    const tasks = await chatTasks(2008);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[0]!.task).toContain("see the attached notes");
    expect(tasks[0]!.task).toMatch(/\[File: notes\.txt \(text\/plain, 14 B\) id=2008_\d+-1\]/);
    const attachments = await getTaskAttachments(tasks[0]!.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "notes.txt", sizeBytes: bytes.byteLength });
  });

  test("overlapping timer flushes of one thread create their tasks in order", async () => {
    // Hold the first message's file download so its flush is still running
    // when the second message's timer flush starts.
    const bytes = new TextEncoder().encode("held file\n");
    harness.mock.addFile("documents/held.txt", bytes);
    let releaseDownload!: () => void;
    const downloadHeld = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/file/bot") && url.endsWith("documents/held.txt")) {
        downloadStarted();
        await downloadHeld;
      }
      return realFetch(input, init);
    }) as typeof fetch;
    process.env.CHAT_SDK_BUFFER_MS = "50";
    const threadId = "telegram:2010";
    try {
      await postTelegramUpdate(
        telegramUpdate(dm(2010), "", {
          caption: "first: read the held file",
          document: {
            file_id: "documents/held.txt",
            file_unique_id: "held-unique",
            file_name: "held.txt",
            mime_type: "text/plain",
            file_size: bytes.byteLength,
          },
        }),
      );
      await started;
      // A longer window for the second message, so the wait below sees it buffered.
      process.env.CHAT_SDK_BUFFER_MS = "300";

      // Not `postTelegramUpdate`: its background drain would wait on the held download.
      const response = await postChatWebhook(
        "telegram",
        JSON.stringify(telegramUpdate(dm(2010), "second: then summarize it")),
        {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
        },
      );
      expect(response.status).toBe(200);
      const waitFor = async (condition: () => boolean) => {
        const deadline = Date.now() + 3_000;
        while (!condition() && Date.now() < deadline) await Bun.sleep(5);
        expect(condition()).toBe(true);
      };
      await waitFor(() => isChatThreadBuffered(threadId));
      await waitFor(() => !isChatThreadBuffered(threadId));
      // The second flush has fired. Without the per-thread chain it would
      // create its task now, before the first one.
      await Bun.sleep(200);
      expect(await chatTasks(2010)).toHaveLength(0);

      releaseDownload();
      expect(await drainBackground(5_000)).toBe(true);
    } finally {
      releaseDownload();
      globalThis.fetch = realFetch;
    }

    const tasks = await chatTasks(2010);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.task).toContain("first: read the held file");
    expect(tasks[1]!.task).toContain("second: then summarize it");
    const second = await getTaskById(tasks[1]!.id);
    expect(second?.dependsOn).toEqual([tasks[0]!.id]);
  });

  test("a message in an unmapped group that does not mention the bot is ignored", async () => {
    await postTelegramUpdate(telegramUpdate(group(-2009), "just chatting"));
    await flushChatBuffers();
    expect(await chatTasks(-2009)).toHaveLength(0);
  });
});

/**
 * Who asked and where. The harness posts every update straight to the
 * webhook, which is what a bot with privacy mode off (or a group admin bot)
 * receives. With privacy mode on Telegram delivers only a subset (commands,
 * mentions, replies to the bot), so these filters hold there too.
 */
describe("Chat SDK requester and group addressing", () => {
  const ACTOR = { kind: "system", id: "chat-sdk-inbound-test" } as const;
  const supergroup = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
    chat: { id, type: "supergroup", title, ...extra },
  });
  const person = (id: number, first: string, username: string) => ({
    from: { id, is_bot: false, first_name: first, username },
  });
  const ALICE = person(777_201, "Alice", "alice");
  const BOB = person(777_202, "Bob", "bob");
  const CAROL = person(777_203, "Carol", "carol");

  async function steeringBodies(taskId: string): Promise<string[]> {
    const rows = await getDbClient().query<{ body: string }>(
      "SELECT body FROM task_steering_messages WHERE task_id = ? ORDER BY rowid",
      [taskId],
    );
    return rows.map((row) => row.body);
  }

  function groupUpdate(chatId: number, text: string, sender: Record<string, unknown>) {
    return telegramUpdate(group(chatId), text, { ...supergroup(chatId, "Life"), ...sender });
  }

  test("a registered user's chat task has requestedByUserId, and defer-task and the relay print their timezone", async () => {
    const user = await createUser({ name: "Taras", timezone: "Europe/Madrid" });
    await linkIdentity(user.id, "telegram", "777101", ACTOR);
    await postTelegramUpdate(
      telegramUpdate(dm(3001), "check the deploy", person(777_101, "Taras", "tarasyarema")),
    );
    await flushChatBuffers();
    const [row] = await chatTasks(3001);
    const task = await getTaskById(row!.id);
    expect(task?.requestedByUserId).toBe(user.id);

    await startTask(task!.id);
    const tool = buildDeferTaskTool();
    const result = (await tool.handler(
      { taskId: task!.id, delayMs: 60_000, summary: "deploy is rolling", note: "wait" },
      { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": lead.id } } },
    )) as { structuredContent: { success: boolean; nextRunAt?: string } };
    expect(result.structuredContent.success).toBe(true);
    const madrid = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(result.structuredContent.nextRunAt!));
    const deferred = await getTaskById(task!.id);
    expect(deferred?.output).toMatch(new RegExp(`at ${madrid}$`));
    expect(deferred?.output).not.toContain("UTC");
    // The relay posts the placeholder text after the task tag (here the trigger
    // drops it: a deferral posts nothing).
    expect(formatChatRelayText(deferred!)).toBe(
      `${formatChatTaskTag(deferred!)}\n\n${deferred!.output!}`,
    );
  });

  test("an unknown sender gets no requester and lands in the Unmapped tracker", async () => {
    await postTelegramUpdate(
      telegramUpdate(dm(3002), "who am I", person(777_102, "Stranger", "stranger")),
    );
    await flushChatBuffers();
    const [row] = await chatTasks(3002);
    expect((await getTaskById(row!.id))?.requestedByUserId).toBeUndefined();
    const meta = await getKv("integration:unmapped:telegram", "777102:meta");
    expect(meta?.value).toMatchObject({ sampleEventType: "chat.message" });
  });

  test("the task description starts with the chat header", async () => {
    await postTelegramUpdate(
      telegramUpdate(group(-3003), "@swarm_test_bot plan the trip", {
        ...supergroup(-3003, "Life"),
        ...person(777_104, "Taras", "tarasyarema"),
      }),
    );
    await flushChatBuffers();
    const [plain] = await chatTasks(-3003);
    expect(plain!.task).toStartWith(
      '[chat] telegram · supergroup "Life" · from: Taras (@tarasyarema) · addressed: mention\n\n',
    );

    // A forum topic: the topic root is the bot's own message, which is the
    // topic and not a reply to the bot.
    await postTelegramUpdate(
      telegramUpdate(group(-3004), "@swarm_test_bot book the flights", {
        ...supergroup(-3004, "Life", { is_forum: true }),
        ...person(777_104, "Taras", "tarasyarema"),
        is_topic_message: true,
        message_thread_id: 77,
        reply_to_message: {
          message_id: 77,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -3004, type: "supergroup", title: "Life", is_forum: true },
          from: { id: 4242, is_bot: true, first_name: "Swarm", username: "swarm_test_bot" },
          forum_topic_created: { name: "Travel", icon_color: 0 },
        },
      }),
    );
    await flushChatBuffers();
    const topicTasks = await getDbClient().query<{ task: string }>(
      "SELECT task FROM agent_tasks WHERE source = 'chat' AND contextKey LIKE ?",
      [`${chatSdkContextKey("telegram:-3004")}%`],
    );
    expect(topicTasks).toHaveLength(1);
    expect(topicTasks[0]!.task).toStartWith(
      '[chat] telegram · supergroup "Life" · forum topic "Travel" · from: Taras (@tarasyarema) · addressed: mention\n\n',
    );
  });

  test("side chatter between two other people neither steers the running task nor creates one; the requester and a mention do", async () => {
    const chatId = -3005;
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot draft the budget", ALICE));
    await flushChatBuffers();
    const [first] = await chatTasks(chatId);
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);

    // Bob and Carol talk to each other.
    await postTelegramUpdate(groupUpdate(chatId, "lunch at 2?", BOB));
    await postTelegramUpdate(groupUpdate(chatId, "sure, the usual place", CAROL));
    await flushChatBuffers();
    expect(await chatTasks(chatId)).toHaveLength(1);
    expect(await steeringBodies(first!.id)).toEqual([]);

    // The requester's plain message, then Bob with a mention.
    await postTelegramUpdate(groupUpdate(chatId, "include the rent", ALICE));
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot and the car", BOB));
    await flushChatBuffers();
    expect(await chatTasks(chatId)).toHaveLength(1);
    expect(await steeringBodies(first!.id)).toEqual(["include the rent", "and the car"]);
  });

  test("an unaddressed group message after the owner window creates no task", async () => {
    const chatId = -3006;
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot book a table", ALICE));
    await flushChatBuffers();
    const [first] = await chatTasks(chatId);
    const endedAt = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
      [endedAt(60), first!.id],
    );

    // An hour after the task ended: even the requester's plain message is ignored.
    await postTelegramUpdate(groupUpdate(chatId, "make it for four", ALICE));
    await flushChatBuffers();
    expect(await chatTasks(chatId)).toHaveLength(1);

    // Control: inside the default 15-minute window the same message is a follow-up.
    await getDbClient().run("UPDATE agent_tasks SET finishedAt = ? WHERE id = ?", [
      endedAt(5),
      first!.id,
    ]);
    await postTelegramUpdate(groupUpdate(chatId, "make it for four", ALICE));
    await flushChatBuffers();
    const tasks = await chatTasks(chatId);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.routingReason).toBe("continuity");
    expect(tasks[1]!.task).toContain("addressed: requester-follow-up");
  });

  test("a reply to the bot counts as a mention without TELEGRAM_MENTION_ON_REPLY", async () => {
    expect(process.env.TELEGRAM_MENTION_ON_REPLY).toBeUndefined();
    const chatId = -3007;
    await postTelegramUpdate(
      groupUpdate(chatId, "yes, go ahead", {
        ...BOB,
        reply_to_message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "supergroup", title: "Life" },
          from: { id: 4242, is_bot: true, first_name: "Swarm", username: "swarm_test_bot" },
          text: "Shall I send the invoice?",
        },
      }),
    );
    await flushChatBuffers();
    const tasks = await chatTasks(chatId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toStartWith(
      '[chat] telegram · supergroup "Life" · from: Bob (@bob) · addressed: reply-to-bot · reply-to: "Shall I send the invoice?"\n\n',
    );
  });

  // A supergroup reply carries `message_thread_id`: the id of the reply chain's
  // first message. Replying to a bot message that starts a chain (a scheduled
  // post, a chat-post) gives `message_thread_id` = the bot message's id, the
  // same shape as a forum topic root, but `is_topic_message` is absent.
  test("a supergroup reply to a bot message that starts a reply chain reaches the gate; chatter still drops", async () => {
    const chatId = -3017;
    const botPost = {
      message_id: 55,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "supergroup", title: "Life" },
      from: { id: 4242, is_bot: true, first_name: "Swarm", username: "swarm_test_bot" },
      text: "Calendar sync is done.",
    };
    const tasksIn = () =>
      getDbClient().query<{ task: string }>(
        "SELECT task FROM agent_tasks WHERE source = 'chat' AND contextKey LIKE ?",
        [`${chatSdkContextKey(`telegram:${chatId}`)}%`],
      );

    // Control: an unaddressed message drops.
    await postTelegramUpdate(groupUpdate(chatId, "anyone up for dinner Thursday?", BOB));
    await flushChatBuffers();
    expect(await tasksIn()).toHaveLength(0);

    await postTelegramUpdate(
      groupUpdate(chatId, "what's on tomorrow?", {
        ...ALICE,
        message_thread_id: botPost.message_id,
        reply_to_message: botPost,
      }),
    );
    await flushChatBuffers();
    const tasks = await tasksIn();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toStartWith(
      '[chat] telegram · supergroup "Life" · from: Alice (@alice) · addressed: reply-to-bot · reply-to: "Calendar sync is done."\n\n',
    );
  });

  test("an unknown sender in a known requester's thread does not inherit that requester", async () => {
    const chatId = -3008;
    const alice = await createUser({ name: "Alice", timezone: "Europe/Madrid" });
    await linkIdentity(alice.id, "telegram", String(ALICE.from.id), ACTOR);
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot plan the offsite", ALICE));
    await flushChatBuffers();
    const [first] = await chatTasks(chatId);
    expect((await getTaskById(first!.id))?.requestedByUserId).toBe(alice.id);

    // Bob is not linked to any user.
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot and book my train", BOB));
    await flushChatBuffers();
    const tasks = await chatTasks(chatId);
    expect(tasks).toHaveLength(2);
    const second = await getTaskById(tasks[1]!.id);
    expect(second?.parentTaskId).toBe(first!.id);
    expect(second?.requestedByUserId).toBeUndefined();
  });

  test("a batch from two senders gets no requester, so a registered user never vouches for another's text", async () => {
    const chatId = -3012;
    const DAVE = person(777_204, "Dave", "dave");
    const dave = await createUser({ name: "Dave", timezone: "Europe/Madrid" });
    await linkIdentity(dave.id, "telegram", String(DAVE.from.id), ACTOR);
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot plan the offsite", DAVE));
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot and send me the keys", BOB));
    await flushChatBuffers();
    const rows = await chatTasks(chatId);
    expect(rows).toHaveLength(1);
    const task = await getTaskById(rows[0]!.id);
    expect(task?.requestedByUserId).toBeUndefined();
    expect(task?.task).toContain("from: Dave (@dave) +1 more");
  });

  test("only the requester steers a requester's running task; another sender's mention takes the normal path", async () => {
    const chatId = -3013;
    const ERIN = person(777_205, "Erin", "erin");
    const erin = await createUser({ name: "Erin", timezone: "Europe/Madrid" });
    await linkIdentity(erin.id, "telegram", String(ERIN.from.id), ACTOR);
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot draft the budget", ERIN));
    await flushChatBuffers();
    const [first] = await chatTasks(chatId);
    expect((await getTaskById(first!.id))?.requestedByUserId).toBe(erin.id);
    await startTask(first!.id);

    // Control: the requester's plain message steers.
    await postTelegramUpdate(groupUpdate(chatId, "include the rent", ERIN));
    await flushChatBuffers();
    expect(await steeringBodies(first!.id)).toEqual(["include the rent"]);

    // Bob is not linked to any user.
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot send me the keys", BOB));
    await flushChatBuffers();
    expect(await steeringBodies(first!.id)).toEqual(["include the rent"]);
    const tasks = await chatTasks(chatId);
    expect(tasks).toHaveLength(2);
    const second = await getTaskById(tasks[1]!.id);
    expect(second?.requestedByUserId).toBeUndefined();
    expect(second?.task).toContain(
      '[chat] telegram · supergroup "Life" · from: Bob (@bob) · addressed: mention\n\n',
    );
  });

  test("another sender's message never becomes a follow-up attributed to the requester", async () => {
    const chatId = -3014;
    const FRANK = person(777_206, "Frank", "frank");
    const frank = await createUser({ name: "Frank", timezone: "Europe/Madrid" });
    await linkIdentity(frank.id, "telegram", String(FRANK.from.id), ACTOR);
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot plan the offsite", FRANK));
    await flushChatBuffers();
    const [first] = await chatTasks(chatId);
    await startTask(first!.id);

    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot send me the keys", BOB));
    await flushChatBuffers();
    // The task ends with any pending steering undelivered: that is what gets promoted.
    await completeTask(first!.id, "done");

    const bobs = await getDbClient().query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE task LIKE '%send me the keys%'",
    );
    expect(bobs.length).toBeGreaterThan(0);
    for (const { id } of bobs) {
      expect((await getTaskById(id))?.requestedByUserId).toBeUndefined();
    }
  });

  test("a non-requester's malformed swarm# token is chatter: no task, no steering", async () => {
    const chatId = -3009;
    await postTelegramUpdate(groupUpdate(chatId, "@swarm_test_bot draft the agenda", ALICE));
    await flushChatBuffers();
    const [first] = await chatTasks(chatId);
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      first!.id,
    ]);

    await postTelegramUpdate(groupUpdate(chatId, "Carol, what does swarm# mean?", BOB));
    await postTelegramUpdate(groupUpdate(chatId, "swarm#everyone is it a hashtag?", CAROL));
    await flushChatBuffers();
    expect(await chatTasks(chatId)).toHaveLength(1);
    expect(await steeringBodies(first!.id)).toEqual([]);

    // Control: once the task is done, a real token from a non-requester still routes.
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
      [new Date().toISOString(), first!.id],
    );
    await postTelegramUpdate(groupUpdate(chatId, `swarm#${worker.id} check the numbers`, BOB));
    await flushChatBuffers();
    const tasks = await chatTasks(chatId);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.agentId).toBe(worker.id);
  });

  test("only a Telegram group expires the thread owner; DMs and other adapters keep continuity", async () => {
    const finishedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    async function seedFinishedOwner(threadId: string): Promise<void> {
      const task = await createTaskExtended("earlier ask", {
        agentId: worker.id,
        source: "chat",
        contextKey: chatSdkContextKey(threadId),
      });
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
        [finishedAt, task.id],
      );
    }
    const continuity = {
      kind: "agents",
      matches: [
        {
          agent: expect.objectContaining({ id: worker.id }),
          reason: "continuity",
          matchedText: "thread follow-up",
        },
      ],
    };
    const contexts = [
      { adapter: "telegram", channelId: "telegram:3101", threadId: "telegram:3101", dm: true },
      { adapter: "slack", channelId: "slack:C3101", threadId: "slack:C3101:1700000000.000100" },
      { adapter: "discord", channelId: "discord:g1:c3101", threadId: "discord:g1:c3101:t1" },
      { adapter: "teams", channelId: "teams:c3101", threadId: "teams:c3101:m1" },
    ];
    for (const { dm: isDirectMessage = false, ...ctx } of contexts) {
      await seedFinishedOwner(ctx.threadId);
      expect(
        await routeChatMessage("one more thing", { ...ctx, botMentioned: false, isDirectMessage }),
      ).toEqual(continuity);
    }

    // Control: a Telegram group thread with the same history has no owner.
    await seedFinishedOwner("telegram:-3101");
    expect(
      await routeChatMessage("one more thing", {
        adapter: "telegram",
        channelId: "telegram:-3101",
        threadId: "telegram:-3101",
        botMentioned: false,
        isDirectMessage: false,
      }),
    ).toBeNull();
  });
});

describe("Chat SDK inbound voice notes and size limit", () => {
  const voiceBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 1, 2, 3]);
  const voiceUpdate = (chatId: number, fileId: string) =>
    telegramUpdate(dm(chatId), "", {
      voice: {
        file_id: fileId,
        file_unique_id: `${fileId}-unique`,
        duration: 2,
        mime_type: "audio/ogg",
        file_size: voiceBytes.byteLength,
      },
    });

  test("a voice note is transcribed into the task text and stays attached", async () => {
    const requests: Array<{ auth: string | null; model: unknown; filename: string }> = [];
    const stt = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const form = await req.formData();
        const file = form.get("file") as File;
        requests.push({
          auth: req.headers.get("authorization"),
          model: form.get("model"),
          filename: file.name,
        });
        return Response.json({ text: "Deploy the staging branch tonight." });
      },
    });
    process.env.TRANSCRIPTION_API_KEY = "stt-test-key";
    process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${stt.port}/v1`;
    try {
      harness.mock.addFile("voice/note-1.oga", voiceBytes);
      await postTelegramUpdate(voiceUpdate(2101, "voice/note-1.oga"));
      await flushChatBuffers();
    } finally {
      stt.stop(true);
      delete process.env.TRANSCRIPTION_API_KEY;
      delete process.env.TRANSCRIPTION_BASE_URL;
    }

    expect(requests).toEqual([
      { auth: "Bearer stt-test-key", model: "whisper-1", filename: "audio-1.ogg" },
    ]);
    const tasks = await chatTasks(2101);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toContain("[Transcript of audio-1]\nDeploy the staging branch tonight.");
    const attachments = await getTaskAttachments(tasks[0]!.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      mimeType: "audio/ogg",
      sizeBytes: voiceBytes.byteLength,
    });
  });

  test("a short transcription key echoed in a provider or network error stays out of logs and task text", async () => {
    const shortKey = "local-pass";
    const stt = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json(
          {
            error: {
              message: `Incorrect API key provided: ${shortKey}. Check your credentials.`,
            },
          },
          { status: 401 },
        ),
    });
    const realFetch = globalThis.fetch;
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    process.env.TRANSCRIPTION_API_KEY = shortKey;
    process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${stt.port}/v1`;
    try {
      harness.mock.addFile("voice/note-401.oga", voiceBytes);
      await postTelegramUpdate(voiceUpdate(2111, "voice/note-401.oga"));
      await flushChatBuffers();

      // The network-error branch: the transport error echoes the key.
      globalThis.fetch = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          String(input instanceof Request ? input.url : input).endsWith("/audio/transcriptions")
            ? Promise.reject(new TypeError(`connect failed, bearer ${shortKey} refused`))
            : realFetch(input, init),
        realFetch,
      );
      harness.mock.addFile("voice/note-net.oga", voiceBytes);
      await postTelegramUpdate(voiceUpdate(2112, "voice/note-net.oga"));
      await flushChatBuffers();
    } finally {
      globalThis.fetch = realFetch;
      warn.mockRestore();
      stt.stop(true);
      delete process.env.TRANSCRIPTION_API_KEY;
      delete process.env.TRANSCRIPTION_BASE_URL;
    }

    for (const [chatId, failure] of [
      [2111, "Incorrect API key provided: [REDACTED:TRANSCRIPTION_API_KEY]"],
      [2112, "connect failed, bearer [REDACTED:TRANSCRIPTION_API_KEY] refused"],
    ] as const) {
      const tasks = await chatTasks(chatId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.task).toContain(`(transcription failed: ${failure}`);
      expect(tasks[0]!.task).not.toContain(shortKey);
      expect(await getTaskAttachments(tasks[0]!.id)).toHaveLength(1);
    }
    const transcriptionWarnings = warnings.filter((line) => line.includes("could not transcribe"));
    expect(transcriptionWarnings).toHaveLength(2);
    expect(warnings.join("\n")).not.toContain(shortKey);
  });

  test("without a transcription provider the voice note is attached with a one-line note", async () => {
    harness.mock.addFile("voice/note-2.oga", voiceBytes);
    await postTelegramUpdate(voiceUpdate(2102, "voice/note-2.oga"));
    await flushChatBuffers();

    const tasks = await chatTasks(2102);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toContain(NOT_TRANSCRIBED_NOTE);
    expect(await getTaskAttachments(tasks[0]!.id)).toHaveLength(1);
  });

  test("a 30 MB file is not downloaded; the task says why and the user gets a too-large reply", async () => {
    const chatId = 2103;
    await postTelegramUpdate(
      telegramUpdate(dm(chatId), "", {
        caption: "here is the recording",
        document: {
          file_id: "documents/big.zip",
          file_unique_id: "big-unique",
          file_name: "big.zip",
          mime_type: "application/zip",
          file_size: 30 * 1024 * 1024,
        },
      }),
    );
    await flushChatBuffers();

    const tasks = await chatTasks(chatId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toContain("big.zip (application/zip, 30.0 MB)");
    expect(tasks[0]!.task).toContain(
      "(not attached: too large (30.0 MB, the limit for files sent to the Telegram bot is 20.0 MB))",
    );
    expect(
      harness.mock.calls.some(
        (call) =>
          call.method === "getFile" &&
          (call.body as { file_id?: string }).file_id === "documents/big.zip",
      ),
    ).toBe(false);
    const replies = harness.mock.calls
      .filter((call) => /^send(Rich)?Message$/.test(call.method))
      .map((call) => call.body as Record<string, unknown>)
      .filter((body) => String(body.chat_id) === String(chatId))
      .map((body) =>
        String((body.rich_message as { markdown?: string } | undefined)?.markdown ?? body.text),
      );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Too large to read");
    expect(replies[0]).toContain("`big.zip`: too large (30.0 MB");
  });
});
