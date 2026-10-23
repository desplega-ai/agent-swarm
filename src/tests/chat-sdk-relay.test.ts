import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  failTask,
  getDbClient,
  initDb,
  startTask,
  supersedeTask,
} from "../be/db";
import { installExtension, setExtensionState } from "../be/extensions/db";
import { listRegistered, registerLoaded, unregister } from "../extensions/dispatcher";
import { ensureExtensionAgent } from "../extensions/identity";
import { cleanExtensionTmpRoot, loadExtension } from "../extensions/loader";
import { initExtensionPostBridge, teardownExtensionPostBridge } from "../extensions/post-bridge";
import { splitChatMessage } from "../integrations/chat-sdk/limits";
import {
  formatChatRelayMessages,
  formatChatRelayText,
  processPendingChatRelays,
  RELAY_GIVE_UP_AFTER_MS,
  stopChatRelayWatcher,
  TELEGRAM_FOLD_CHARS,
} from "../integrations/chat-sdk/relay";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { chatSdkContextKey } from "../tasks/context-key";
import { createResumeFollowUp, createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import type { Agent, AgentTask } from "../types";
import { startTelegramHarness, type TelegramHarness } from "./chat-sdk-harness";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-chat-sdk-relay.sqlite";

let harness: TelegramHarness;
let lead: Agent;
let nextChatId = 880_000;

type ObligationRow = {
  task_id: string;
  delivered_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  given_up_at: string | null;
  last_error: string | null;
};

type Received = { event: string; payload: Record<string, unknown> };
const received: Received[] = [];

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

async function startHarness(): Promise<void> {
  harness = await startTelegramHarness();
  // Ticks are driven by the tests with an injected clock.
  await stopChatRelayWatcher();
}

async function obligation(taskId: string): Promise<ObligationRow | null> {
  return getDbClient().get<ObligationRow>(
    "SELECT * FROM chat_relay_obligations WHERE task_id = ?",
    [taskId],
  );
}

/** Telegram send calls (rich or plain) addressed to `chatId`. */
function sendsTo(chatId: number): Array<Record<string, unknown>> {
  return harness.mock.calls
    .filter((call) => /^send(Rich)?Message$/.test(call.method))
    .map((call) => call.body as Record<string, unknown>)
    .filter((body) => String(body.chat_id) === String(chatId));
}

function sentText(body: Record<string, unknown>): string {
  const rich = body.rich_message as { markdown?: string } | undefined;
  return String(rich?.markdown ?? body.text ?? "");
}

async function createChatTask(
  chatId: number,
  options: { source?: "chat" | "system"; taskType?: string; askMessageId?: number } = {},
): Promise<AgentTask> {
  return createTaskExtended(`chat task for ${chatId}`, {
    agentId: lead.id,
    source: options.source ?? "chat",
    taskType: options.taskType,
    contextKey: chatSdkContextKey(`telegram:${chatId}`),
    ...(options.askMessageId !== undefined
      ? {
          mentionMessageId: `${chatId}:${options.askMessageId}`,
          mentionChannelId: `telegram:${chatId}`,
        }
      : {}),
  });
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  lead = await createAgent({
    id: crypto.randomUUID(),
    name: "ChatRelayLead",
    isLead: true,
    status: "idle",
  });
  await startHarness();
});

afterAll(async () => {
  teardownExtensionPostBridge();
  for (const loaded of listRegistered()) {
    unregister(loaded.record.id);
    await loaded.dispose();
  }
  await cleanExtensionTmpRoot();
  await harness.stop();
  closeDb();
  await removeDbFiles();
});

beforeEach(() => {
  nextChatId += 1;
  harness.mock.failSends(0);
});

describe("chat relay text", () => {
  test("task tag first, status line for failed and cancelled, default for an empty completion", () => {
    const base = {
      id: "a3f2b1c9-0000-4000-8000-000000000000",
      output: undefined,
      failureReason: undefined,
    } as unknown as AgentTask;
    const tag = "#a3f2b1c9 · Coder";
    expect(formatChatRelayText({ ...base, status: "completed" }, "Coder")).toBe(
      `${tag}\n\nTask completed.`,
    );
    expect(formatChatRelayText({ ...base, status: "completed", output: "done" }, "Coder")).toBe(
      `${tag}\n\ndone`,
    );
    expect(formatChatRelayText({ ...base, status: "failed", failureReason: "boom" }, "Coder")).toBe(
      `${tag}\n**Task failed.**\n\nboom`,
    );
    expect(formatChatRelayText({ ...base, status: "cancelled" })).toBe(
      "#a3f2b1c9\n**Task cancelled.**",
    );
  });

  test("a long Telegram answer folds into <details>; other adapters and short answers do not", () => {
    const base = { id: "a3f2b1c9-0000-4000-8000-000000000000", status: "completed" };
    const long = `The short answer is yes.\n\n${"detail line\n".repeat(200)}`.trim();
    const task = { ...base, output: long } as unknown as AgentTask;
    expect(long.length).toBeGreaterThan(TELEGRAM_FOLD_CHARS);

    const [message, ...more] = formatChatRelayMessages(task, "telegram", "Coder");
    expect(more).toHaveLength(0);
    // Tag and first paragraph stay visible; the rest is collapsed.
    expect(message).toStartWith("#a3f2b1c9 · Coder\n\nThe short answer is yes.\n\n<details>");
    expect(message).toContain("<summary>Rest of the answer</summary>");
    expect(message).toEndWith("</details>");

    expect(formatChatRelayMessages(task, "slack", "Coder")).toEqual([
      formatChatRelayText(task, "Coder"),
    ]);
    const short = { ...base, output: "fine" } as unknown as AgentTask;
    expect(formatChatRelayMessages(short, "telegram")).toEqual(["#a3f2b1c9\n\nfine"]);
  });

  test("splitChatMessage keeps every chunk within the limit and loses no text", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitChatMessage(words, 4096);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join(" ")).toBe(words);
    expect(splitChatMessage("short", 4096)).toEqual(["short"]);
  });
});

describe("chat relay watcher", () => {
  test("a completed chat task gets one obligation and one tick posts its output", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    expect(await obligation(task.id)).toBeNull();
    await completeTask(task.id, "The answer is 42.");

    const rows = await getDbClient().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM chat_relay_obligations WHERE task_id = ?",
      [task.id],
    );
    expect(rows[0]?.n).toBe(1);

    await processPendingChatRelays();
    const sends = sendsTo(chatId);
    expect(sends).toHaveLength(1);
    expect(sentText(sends[0] as Record<string, unknown>)).toContain("The answer is 42.");
    const row = await obligation(task.id);
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.attempt_count).toBe(1);

    // Delivered rows never post again.
    await processPendingChatRelays();
    expect(sendsTo(chatId)).toHaveLength(1);
  });

  test("failed and cancelled tasks post with a status line", async () => {
    const failedChat = nextChatId;
    const failed = await createChatTask(failedChat);
    await failTask(failed.id, "the build broke");
    const cancelledChat = nextChatId + 1_000;
    const cancelled = await createTaskExtended("cancel me", {
      agentId: lead.id,
      source: "chat",
      contextKey: chatSdkContextKey(`telegram:${cancelledChat}`),
    });
    await cancelTask(cancelled.id, "user changed their mind");

    await processPendingChatRelays();
    expect(sentText(sendsTo(failedChat)[0] ?? {})).toContain("Task failed.");
    expect(sentText(sendsTo(failedChat)[0] ?? {})).toContain("the build broke");
    expect(sentText(sendsTo(cancelledChat)[0] ?? {})).toContain("Task cancelled.");
  });

  test("a platform error leaves the row pending with backoff, then a later tick delivers", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "retry me");
    harness.mock.failSends(100);

    const now = Date.now();
    await processPendingChatRelays(now);
    let row = await obligation(task.id);
    expect(row?.delivered_at).toBeNull();
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error).toBeTruthy();
    const failedCalls = sendsTo(chatId).length;
    expect(failedCalls).toBeGreaterThanOrEqual(1);

    // 1 s later the row is still in backoff (3 s * 2^1 = 6 s): no call, no attempt.
    harness.mock.failSends(0);
    await processPendingChatRelays(now + 1_000);
    row = await obligation(task.id);
    expect(row?.attempt_count).toBe(1);
    expect(sendsTo(chatId)).toHaveLength(failedCalls);

    await processPendingChatRelays(now + 7_000);
    row = await obligation(task.id);
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.attempt_count).toBe(2);
    expect(sentText(sendsTo(chatId).at(-1) ?? {})).toContain("retry me");
  });

  test("lead delegation: the chat task and its follow-up both reach the thread", async () => {
    const chatId = nextChatId;
    const leadTask = await createChatTask(chatId);
    await completeTask(leadTask.id, "Delegated to a worker.");
    // No explicit contextKey: the follow-up inherits it from its parent.
    const followUp = await createTaskExtended("worker finished", {
      agentId: lead.id,
      source: "system",
      taskType: "follow-up",
      parentTaskId: leadTask.id,
    });
    expect(followUp.contextKey).toBe(leadTask.contextKey);
    await completeTask(followUp.id, "Worker result: all green.");
    // A system task that is not a follow-up stays silent.
    const other = await createChatTask(chatId, { source: "system", taskType: "maintenance" });
    await completeTask(other.id, "internal");

    await processPendingChatRelays();
    const texts = sendsTo(chatId).map(sentText);
    expect(texts).toHaveLength(2);
    expect(texts.some((text) => text.includes("Delegated to a worker."))).toBe(true);
    expect(texts.some((text) => text.includes("Worker result: all green."))).toBe(true);
    expect(await obligation(other.id)).toBeNull();
  });

  test("a 9000-character output arrives as three Telegram messages", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    const output = Array.from({ length: 1000 }, (_, i) => `line${String(i).padStart(4, "0")}`).join(
      "\n",
    );
    expect(output.length).toBeGreaterThan(8_500);
    expect(output.length).toBeLessThan(9_500);
    await completeTask(task.id, output);
    await processPendingChatRelays();
    const sends = sendsTo(chatId);
    expect(sends).toHaveLength(3);
    for (const body of sends) expect(sentText(body).length).toBeLessThanOrEqual(4096);
    expect((await obligation(task.id))?.delivered_at).not.toBeNull();
  });

  test("post.chat.message outbound reaches an extension", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.manifest = { ...bundle.manifest, name: "chat-relay-capture" };
    const installed = await installExtension({ ...bundle, priority: 100 });
    const record = await setExtensionState(installed.extension.id, {
      agentId: await ensureExtensionAgent(installed.extension.name),
    });
    const loaded = await loadExtension({ record: record!, ...bundle });
    loaded.handlers = [
      {
        event: "post.chat.message",
        priority: 100,
        handler: (payload: never) => {
          received.push({ event: "post.chat.message", payload });
        },
      },
    ];
    registerLoaded(loaded);
    initExtensionPostBridge();

    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "observed by an extension");
    await processPendingChatRelays();

    const deadline = Date.now() + 5_000;
    while (!received.some((r) => r.payload.taskId === task.id) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    const event = received.find((r) => r.payload.taskId === task.id);
    expect(event?.payload).toMatchObject({
      adapter: "telegram",
      threadId: `telegram:${chatId}`,
      direction: "outbound",
      text: `#${task.id.slice(0, 8)} · ChatRelayLead\n\nobserved by an extension`,
      taskId: task.id,
    });
  });

  test("an adapter that is not running skips the row without counting an attempt", async () => {
    await harness.stop();
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "after the restart");
    await processPendingChatRelays();
    let row = await obligation(task.id);
    expect(row?.attempt_count).toBe(0);
    expect(row?.given_up_at).toBeNull();

    await startHarness();
    // The watcher's first tick on boot may already have delivered it.
    await processPendingChatRelays();
    row = await obligation(task.id);
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.attempt_count).toBe(1);
    expect(sendsTo(chatId)).toHaveLength(1);
  });

  test("a healthy adapter is delivered even when stopped-adapter rows pile up", async () => {
    // Discord is never started in this harness, so its rows stay undelivered.
    for (let i = 0; i < 3; i++) {
      const stuck = await createTaskExtended(`stuck ${i}`, {
        agentId: lead.id,
        source: "chat",
        contextKey: chatSdkContextKey(`discord:${nextChatId}${i}`),
      });
      await completeTask(stuck.id, "stuck output");
    }
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "healthy output");

    await processPendingChatRelays();
    expect((await obligation(task.id))?.delivered_at).not.toBeNull();
    expect(sendsTo(chatId)).toHaveLength(1);
    const stuckRows = await getDbClient().query<ObligationRow>(
      `SELECT o.* FROM chat_relay_obligations o JOIN agent_tasks t ON t.id = o.task_id
         WHERE t.contextKey LIKE 'task:chat-sdk:discord:%' AND o.delivered_at IS NULL`,
    );
    expect(stuckRows.length).toBeGreaterThanOrEqual(3);
    expect(stuckRows.every((row) => row.attempt_count === 0)).toBe(true);
  });

  test("two concurrent ticks deliver one obligation once", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "only once");
    const now = Date.now();
    await Promise.all([processPendingChatRelays(now), processPendingChatRelays(now)]);
    expect(sendsTo(chatId)).toHaveLength(1);
    const row = await obligation(task.id);
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.attempt_count).toBe(1);
  });

  test("backoff is capped at 10 minutes", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "capped backoff");
    const base = Date.now();
    await getDbClient().run(
      "UPDATE chat_relay_obligations SET attempt_count = 9, last_attempt_at = ? WHERE task_id = ?",
      [new Date(base).toISOString(), task.id],
    );

    // 3 s * 2^9 would be 25 min; the cap makes the row eligible after 10 min.
    await processPendingChatRelays(base + 599_000);
    expect(sendsTo(chatId)).toHaveLength(0);
    expect((await obligation(task.id))?.attempt_count).toBe(9);

    await processPendingChatRelays(base + 601_000);
    expect(sendsTo(chatId)).toHaveLength(1);
    expect((await obligation(task.id))?.delivered_at).not.toBeNull();
  });

  test("a resumed lead chat task relays its final answer", async () => {
    // A fresh lead with spare capacity, so the graceful-shutdown resume pins to it.
    const resumeLead = await createAgent({
      id: crypto.randomUUID(),
      name: "ChatRelayResumeLead",
      isLead: true,
      status: "idle",
      maxTasks: 5,
    });
    const chatId = nextChatId;
    const parent = await createTaskExtended("chat task to resume", {
      agentId: resumeLead.id,
      source: "chat",
      contextKey: chatSdkContextKey(`telegram:${chatId}`),
    });
    await startTask(parent.id);
    await supersedeTask(parent.id, { reason: "graceful_shutdown", resumeTaskId: null });
    const result = await createResumeFollowUp({ parentId: parent.id, reason: "graceful_shutdown" });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    const resume = result.task;
    expect(resume.source).toBe("system");
    expect(resume.taskType).toBe("resume");
    expect(resume.agentId).toBe(resumeLead.id);
    expect(resume.contextKey).toBe(parent.contextKey);

    await completeTask(resume.id, "Resumed answer: 7.");
    // The superseded parent never relays; the resume carries the answer.
    expect(await obligation(parent.id)).toBeNull();
    expect(await obligation(resume.id)).not.toBeNull();

    await processPendingChatRelays();
    const texts = sendsTo(chatId).map(sentText);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Resumed answer: 7.");
    expect((await obligation(resume.id))?.delivered_at).not.toBeNull();
  });

  test("the answer replies to the ask and starts with the task tag", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId, { askMessageId: 41 });
    await completeTask(task.id, "Here is your answer.");
    await processPendingChatRelays();

    const [send, ...rest] = sendsTo(chatId);
    expect(rest).toHaveLength(0);
    expect(send?.reply_parameters).toEqual({ message_id: 41, allow_sending_without_reply: true });
    // The line-leading tag is escaped so Telegram does not render it as a heading.
    expect(sentText(send ?? {})).toStartWith(`\\#${task.id.slice(0, 8)} · ChatRelayLead`);
    expect(sentText(send ?? {})).toContain("Here is your answer.");
  });

  test("the answer turns the ask's reaction into 👍, or 👎 for a failed task", async () => {
    const reactionsTo = (chatId: number) =>
      harness.mock.calls
        .filter((call) => call.method === "setMessageReaction")
        .map((call) => call.body as Record<string, unknown>)
        .filter((body) => String(body.chat_id) === String(chatId));
    const doneChat = nextChatId;
    const done = await createChatTask(doneChat, { askMessageId: 51 });
    await completeTask(done.id, "Done.");
    const failedChat = nextChatId + 2_000;
    const failed = await createChatTask(failedChat, { askMessageId: 52 });
    await failTask(failed.id, "the build broke");
    await processPendingChatRelays();

    expect(reactionsTo(doneChat)).toEqual([
      expect.objectContaining({ message_id: 51, reaction: [{ type: "emoji", emoji: "👍" }] }),
    ]);
    expect(reactionsTo(failedChat)).toEqual([
      expect.objectContaining({ message_id: 52, reaction: [{ type: "emoji", emoji: "👎" }] }),
    ]);
  });

  test("a REACTION_INVALID answer never fails the delivery", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId, { askMessageId: 61 });
    await completeTask(task.id, "Still delivered.");
    harness.mock.failReactions(1);
    try {
      await processPendingChatRelays();
    } finally {
      harness.mock.failReactions(0);
    }
    expect(sentText(sendsTo(chatId)[0] ?? {})).toContain("Still delivered.");
    const row = await obligation(task.id);
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.last_error).toBeNull();
    expect(
      harness.mock.calls.some(
        (call) =>
          call.method === "setMessageReaction" &&
          String((call.body as Record<string, unknown>).chat_id) === String(chatId),
      ),
    ).toBe(true);
  });

  test("a chunked answer anchors only its first message", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId, { askMessageId: 42 });
    const output = Array.from({ length: 1000 }, (_, i) => `line${String(i).padStart(4, "0")}`).join(
      "\n",
    );
    await completeTask(task.id, output);
    await processPendingChatRelays();

    const sends = sendsTo(chatId);
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]?.reply_parameters).toEqual({
      message_id: 42,
      allow_sending_without_reply: true,
    });
    for (const later of sends.slice(1)) expect(later.reply_parameters).toBeUndefined();
    // Every message carries a whole collapsed block.
    for (const body of sends) {
      expect(sentText(body)).toContain("<details>");
      expect(sentText(body)).toEndWith("</details>");
      expect(sentText(body).length).toBeLessThanOrEqual(4096);
    }
  });

  test("a deferred task posts nothing; its wake-up answers the original ask", async () => {
    const chatId = nextChatId;
    const deferred = await createChatTask(chatId, { askMessageId: 43 });
    await completeTask(deferred.id, "Deferred until 18:00.", {
      addTags: ["deferred"],
      deferredAt: new Date().toISOString(),
    });
    expect(await obligation(deferred.id)).toBeNull();

    // What defer-task books; the scheduler fires it later.
    const schedule = await createScheduledTask({
      name: `deferred-${deferred.id.slice(0, 8)}-${crypto.randomUUID()}`,
      taskTemplate: "Check the deploy and answer.",
      targetType: "agent-task",
      scheduleType: "one_time",
      nextRunAt: new Date().toISOString(),
      targetAgentId: lead.id,
      createdByAgentId: lead.id,
      taskType: "deferred",
      tags: ["deferred"],
      parentTaskId: deferred.id,
    });
    const wakeUp = await createStandaloneScheduleTask(schedule);
    expect(wakeUp.contextKey).toBe(deferred.contextKey);
    expect(wakeUp.mentionMessageId).toBe(`${chatId}:43`);
    await completeTask(wakeUp.id, "The deploy is live.");

    await processPendingChatRelays();
    const sends = sendsTo(chatId);
    expect(sends).toHaveLength(1);
    expect(sentText(sends[0] ?? {})).toContain("The deploy is live.");
    expect(sentText(sends[0] ?? {})).not.toContain("Deferred until");
    expect(sends[0]?.reply_parameters).toEqual({
      message_id: 43,
      allow_sending_without_reply: true,
    });
  });

  test("a wake-up of a task outside chat keeps its schedule contextKey", async () => {
    const parent = await createTaskExtended("not a chat task", { agentId: lead.id });
    const schedule = await createScheduledTask({
      name: `deferred-${parent.id.slice(0, 8)}-${crypto.randomUUID()}`,
      taskTemplate: "wake up",
      targetType: "agent-task",
      scheduleType: "one_time",
      nextRunAt: new Date().toISOString(),
      targetAgentId: lead.id,
      createdByAgentId: lead.id,
      taskType: "deferred",
      parentTaskId: parent.id,
    });
    const wakeUp = await createStandaloneScheduleTask(schedule);
    expect(wakeUp.contextKey).toBe(`task:schedule:${schedule.id}`);
  });

  describe("a delegated worker's deferral", () => {
    let worker: Agent;
    let otherWorker: Agent;

    beforeAll(async () => {
      worker = await createAgent({
        id: crypto.randomUUID(),
        name: "ChatRelayDeferringWorker",
        isLead: false,
        status: "idle",
        maxTasks: 5,
      });
      otherWorker = await createAgent({
        id: crypto.randomUUID(),
        name: "ChatRelayRetargetWorker",
        isLead: false,
        status: "idle",
        maxTasks: 5,
      });
    });

    /** A Lead chat ask (anchored on message 43) delegated to `worker`. */
    async function delegate(
      chatId: number,
    ): Promise<{ leadTask: AgentTask; delegated: AgentTask }> {
      const leadTask = await createChatTask(chatId, { askMessageId: 43 });
      const delegated = await createTaskExtended("worker part", {
        agentId: worker.id,
        creatorAgentId: lead.id,
        source: "mcp",
        parentTaskId: leadTask.id,
      });
      expect(delegated.contextKey).toBe(leadTask.contextKey);
      return { leadTask, delegated };
    }

    /** What defer-task books for `task`, fired by the scheduler. */
    async function deferAndWake(
      task: AgentTask,
      options: { targetAgentId?: string } = {},
    ): Promise<AgentTask> {
      await completeTask(task.id, "Checking back later.", {
        deferredAt: new Date().toISOString(),
      });
      const schedule = await createScheduledTask({
        name: `deferred-${task.id.slice(0, 8)}-${crypto.randomUUID()}`,
        taskTemplate: "resume the worker part",
        targetType: "agent-task",
        scheduleType: "one_time",
        nextRunAt: new Date().toISOString(),
        targetAgentId: options.targetAgentId ?? task.agentId ?? undefined,
        createdByAgentId: task.agentId ?? undefined,
        taskType: "deferred",
        parentTaskId: task.id,
      });
      const wakeUp = await createStandaloneScheduleTask(schedule);
      // The worker reports through the Lead, as its delegated task did.
      expect(wakeUp.contextKey).toBe(`task:schedule:${schedule.id}`);
      return wakeUp;
    }

    /**
     * Completes the worker's `task` with raw output, then runs its Lead
     * follow-up to a reviewed answer. Returns what reached the chat.
     */
    async function reportThroughLead(
      task: AgentTask,
      chatId: number,
      leadTask: AgentTask,
    ): Promise<Array<Record<string, unknown>>> {
      const completed = await completeTask(task.id, "RAW PRIVATE WORKER RESULT");
      expect(completed).not.toBeNull();
      expect(await obligation(task.id)).toBeNull();
      const followUp = await createWorkerTaskFollowUp({
        task: completed!,
        status: "completed",
        output: completed!.output,
      });
      await processPendingChatRelays();
      expect(sendsTo(chatId)).toHaveLength(0);

      expect(followUp?.agentId).toBe(lead.id);
      expect(followUp?.contextKey).toBe(leadTask.contextKey);
      expect(followUp?.mentionMessageId).toBe(`${chatId}:43`);
      await completeTask(followUp!.id, "REVIEWED LEAD ANSWER");
      await processPendingChatRelays();
      return sendsTo(chatId);
    }

    function expectOneReviewedAnswer(sends: Array<Record<string, unknown>>): void {
      expect(sends).toHaveLength(1);
      expect(sentText(sends[0] ?? {})).toContain("REVIEWED LEAD ANSWER");
      expect(sentText(sends[0] ?? {})).not.toContain("RAW PRIVATE WORKER RESULT");
      expect(sends[0]?.reply_parameters).toEqual({
        message_id: 43,
        allow_sending_without_reply: true,
      });
    }

    test("control: an undeferred worker reports one reviewed answer", async () => {
      const chatId = nextChatId;
      const { leadTask, delegated } = await delegate(chatId);
      expectOneReviewedAnswer(await reportThroughLead(delegated, chatId, leadTask));
    });

    test("wakes up outside the chat, stays silent and reports through the Lead", async () => {
      const chatId = nextChatId;
      const { leadTask, delegated } = await delegate(chatId);
      const wakeUp = await deferAndWake(delegated);
      expectOneReviewedAnswer(await reportThroughLead(wakeUp, chatId, leadTask));
    });

    test("a repeated deferral still reports through the Lead", async () => {
      const chatId = nextChatId;
      const { leadTask, delegated } = await delegate(chatId);
      const firstWake = await deferAndWake(delegated);
      const secondWake = await deferAndWake(firstWake);
      expect(await obligation(firstWake.id)).toBeNull();
      expectOneReviewedAnswer(await reportThroughLead(secondWake, chatId, leadTask));
    });

    test("a resume of the wake-up still reports through the Lead", async () => {
      const chatId = nextChatId;
      const { leadTask, delegated } = await delegate(chatId);
      const wakeUp = await deferAndWake(delegated);
      await startTask(wakeUp.id);
      await supersedeTask(wakeUp.id, { reason: "graceful_shutdown", resumeTaskId: null });
      const result = await createResumeFollowUp({
        parentId: wakeUp.id,
        reason: "graceful_shutdown",
      });
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;
      expect(result.task.agentId).toBe(worker.id);
      expect(result.task.contextKey).toBe(wakeUp.contextKey);
      expectOneReviewedAnswer(await reportThroughLead(result.task, chatId, leadTask));
    });

    test("a wake-up re-targeted to another worker reports through the Lead", async () => {
      const chatId = nextChatId;
      const { leadTask, delegated } = await delegate(chatId);
      const wakeUp = await deferAndWake(delegated, { targetAgentId: otherWorker.id });
      expect(wakeUp.agentId).toBe(otherWorker.id);
      expectOneReviewedAnswer(await reportThroughLead(wakeUp, chatId, leadTask));
    });
  });

  test("a deferred wake-up that runs as another agent than its parent is not relayed", async () => {
    const other = await createAgent({
      id: crypto.randomUUID(),
      name: "ChatRelayOtherAgent",
      isLead: false,
      status: "idle",
    });
    const chatId = nextChatId;
    const parent = await createChatTask(chatId);
    await completeTask(parent.id, "Deferred.", { deferredAt: new Date().toISOString() });
    // Bypasses the scheduler's check: the triggers hold the same line.
    const wakeUp = await createTaskExtended("not the deferring agent", {
      agentId: other.id,
      source: "schedule",
      taskType: "deferred",
      parentTaskId: parent.id,
      contextKey: parent.contextKey,
    });
    await completeTask(wakeUp.id, "OTHER AGENT OUTPUT");

    expect(await obligation(wakeUp.id)).toBeNull();
    await processPendingChatRelays();
    expect(sendsTo(chatId)).toHaveLength(0);
  });

  test("delegated worker tasks and their resumes stay silent", async () => {
    const worker = await createAgent({
      id: crypto.randomUUID(),
      name: "ChatRelayWorker",
      isLead: false,
      status: "idle",
      maxTasks: 5,
    });
    const chatId = nextChatId;
    const leadTask = await createChatTask(chatId);
    // Inherits the chat contextKey from its parent.
    const delegated = await createTaskExtended("worker part", {
      agentId: worker.id,
      source: "system",
      taskType: "delegated",
      parentTaskId: leadTask.id,
    });
    expect(delegated.contextKey).toBe(leadTask.contextKey);
    await completeTask(delegated.id, "raw worker output");

    // A worker resume reports back through a lead follow-up, not on its own.
    const interrupted = await createTaskExtended("worker part 2", {
      agentId: worker.id,
      source: "system",
      taskType: "delegated",
      parentTaskId: leadTask.id,
    });
    await startTask(interrupted.id);
    await supersedeTask(interrupted.id, { reason: "graceful_shutdown", resumeTaskId: null });
    const result = await createResumeFollowUp({
      parentId: interrupted.id,
      reason: "graceful_shutdown",
    });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.task.agentId).toBe(worker.id);
    expect(result.task.contextKey).toBe(leadTask.contextKey);
    await completeTask(result.task.id, "raw resumed worker output");

    expect(await obligation(delegated.id)).toBeNull();
    expect(await obligation(interrupted.id)).toBeNull();
    expect(await obligation(result.task.id)).toBeNull();
    await processPendingChatRelays();
    expect(sendsTo(chatId)).toHaveLength(0);
  });

  // Last on purpose: the give-up sweep retires every pending row older than 24h
  // at the injected clock, so it must not run before other cases create rows.
  test("a row older than RELAY_GIVE_UP_AFTER_MS is given up without a send", async () => {
    const chatId = nextChatId;
    const task = await createChatTask(chatId);
    await completeTask(task.id, "too late");
    await processPendingChatRelays(Date.now() + RELAY_GIVE_UP_AFTER_MS + 60 * 60 * 1000);
    const row = await obligation(task.id);
    expect(row?.given_up_at).not.toBeNull();
    expect(row?.delivered_at).toBeNull();
    expect(row?.last_error).toBe("gave up: older than 24h");
    expect(sendsTo(chatId)).toHaveLength(0);
  });
});
