import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  getDbClient,
  getTaskAttachments,
  getTaskById,
  initDb,
  upsertKv,
} from "../be/db";
import { resetFileStorageProviderForTests } from "../fs/registry";
import { CHAT_CHANNELS_NAMESPACE } from "../integrations/chat-sdk/router";
import { getChatInstance } from "../integrations/chat-sdk/runtime";
import { chatSdkContextKey } from "../tasks/context-key";
import type { Agent } from "../types";
import {
  flushChatBuffers,
  postTelegramUpdate,
  startTelegramHarness,
  type TelegramChat,
  type TelegramHarness,
  telegramUpdate,
} from "./chat-sdk-telegram-harness";

const TEST_DB_PATH = "./test-chat-sdk-inbound.sqlite";
const ENV_KEYS = ["AGENT_FS_LOCAL_DIR", "AGENT_FS_API_URL", "STEERING_ENABLED"];
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

const dm = (id: number): TelegramChat => ({ id, type: "private" });
const group = (id: number): TelegramChat => ({ id, type: "group" });

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
    expect(tasks[0]!.task).toBe("ship the hotfix");
  });

  test("swarm#<uuid> routes to that agent", async () => {
    await postTelegramUpdate(telegramUpdate(dm(2003), `swarm#${worker.id} build the parser`));
    await flushChatBuffers();
    const tasks = await chatTasks(2003);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(worker.id);
    expect(tasks[0]!.task).toBe("build the parser");
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

    const acksBefore = harness.mock.calls.filter((call) =>
      /^send(Rich)?Message$/.test(call.method),
    ).length;
    await postTelegramUpdate(telegramUpdate(group(-2005), "also add the charts"));
    await flushChatBuffers();

    expect(await chatTasks(-2005)).toHaveLength(1);
    expect(await steeringRows(first!.id)).toEqual([
      { body: "also add the charts", source: "chat" },
    ]);
    expect(
      harness.mock.calls.filter((call) => /^send(Rich)?Message$/.test(call.method)).length,
    ).toBe(acksBefore + 1);
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

  test("a message in an unmapped group that does not mention the bot is ignored", async () => {
    await postTelegramUpdate(telegramUpdate(group(-2009), "just chatting"));
    await flushChatBuffers();
    expect(await chatTasks(-2009)).toHaveLength(0);
  });
});
