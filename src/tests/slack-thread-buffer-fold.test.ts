import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getSlackTasksInThread,
  getSteeringMessagesForTask,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { findOrCreateUserByEmail, linkIdentity } from "../be/users";
import * as contractRuntime from "../extensions/contract-runtime";
import { slackContextKey } from "../tasks/context-key";

// `swarm-extension` is a bare import the extension loader shims to contract-runtime.
mock.module("swarm-extension", () => contractRuntime);
const { parseFollowUp } = await import("../../templates/extensions/slack-reply-gate/hooks");

process.env.SLACK_RENDER_V2 = "false";

const TEST_DB_PATH = `/tmp/agent-swarm-slack-thread-buffer-fold-${process.pid}.sqlite`;
const previousSteeringEnabled = process.env.STEERING_ENABLED;

// Slack's view of every thread: the root plus whatever replies a test adds.
let threadMessages: Array<Record<string, unknown>> = [];
// Runs while the flush reads the thread, after its steering check: the window
// in which a worker can claim the pending task.
let onThreadRead: (() => Promise<void>) | undefined;
let posted: string[] = [];

const realSlackApp = await import("../slack/app");
mock.module("../slack/app", () => ({
  ...realSlackApp,
  getSlackApp: () => ({
    client: {
      conversations: {
        replies: async () => {
          await onThreadRead?.();
          return { ok: true, messages: threadMessages };
        },
      },
      users: { info: async () => ({ ok: true, user: { profile: {} } }) },
      reactions: { add: async () => ({ ok: true }) },
      chat: {
        postMessage: async (args: { text: string }) => {
          posted.push(args.text);
          return { ok: true, ts: "9999.0001" };
        },
      },
    },
  }),
}));

const { appendFollowUpMessages, bufferThreadMessage, instantFlush } = await import(
  "../slack/thread-buffer"
);
const { buildSlackThreadSnapshot } = await import("../slack/thread-participants");
const { getSlackApp } = await import("../slack/app");

let leadId: string;

beforeAll(async () => {
  process.env.STEERING_ENABLED = "false";
  initDb(TEST_DB_PATH);
  leadId = (
    await createAgent({
      name: "fold-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
      harnessProvider: "pi",
    })
  ).id;
});

afterAll(() => {
  if (previousSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
  else process.env.STEERING_ENABLED = previousSteeringEnabled;
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  process.env.STEERING_ENABLED = "false";
  onThreadRead = undefined;
  posted = [];
});

/** A pending Lead task as the @mention path creates it, with its own thread context. */
async function pendingMentionTask(channelId: string, threadTs: string, triggerTs: string) {
  threadMessages = [
    { ts: threadTs, user: "U0ROOT", text: "root message of the thread" },
    { ts: triggerTs, user: "U0ROOT", text: "<@U0BOT> please look at this" },
  ];
  return await createTaskExtended(
    "<thread_context>\n<@U0ROOT>: root message of the thread\n</thread_context>\n\n<@U0ROOT>: please look at this",
    {
      agentId: leadId,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      slackUserId: "U0ROOT",
      contextKey: slackContextKey({ channelId, threadTs }),
    },
  );
}

async function flush(channelId: string, threadTs: string, text: string, user: string, ts: string) {
  threadMessages.push({ ts, user, text });
  await bufferThreadMessage(channelId, threadTs, text, user, ts);
  await instantFlush(`${channelId}:${threadTs}`);
}

async function registeredSlackUser(slackUserId: string, email: string): Promise<string> {
  const actor = { kind: "system", id: "test" } as const;
  const { user } = await findOrCreateUserByEmail(email, { name: slackUserId }, actor);
  await linkIdentity(user.id, "slack", slackUserId, actor);
  return user.id;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buffered follow-ups fold into a pending Lead task", () => {
  test("two flushes while the task is pending: one task, each message once, one thread context", async () => {
    const [channelId, threadTs] = ["C0FOLD1", "1000.0001"];
    const target = await pendingMentionTask(channelId, threadTs, "1000.0002");

    await flush(channelId, threadTs, "first follow-up", "U0ROOT", "1000.0003");
    await flush(channelId, threadTs, "second follow-up", "U0OTHER", "1000.0004");

    const tasks = await getSlackTasksInThread(channelId, threadTs);
    expect(tasks.map((task) => task.id)).toEqual([target.id]);
    const description = (await getTaskById(target.id))!.task;
    expect(count(description, "<thread_context>")).toBe(1);
    expect(count(description, "root message of the thread")).toBe(1);
    expect(count(description, "please look at this")).toBe(1);
    expect(count(description, "first follow-up")).toBe(1);
    expect(count(description, "second follow-up")).toBe(1);
    expect(count(description, "[Thread follow-up")).toBe(1);
    // The ask plus the two follow-ups, all under the one header.
    expect(description).toContain("[Thread follow-up — 3 message(s) buffered]");
    expect(description.indexOf("first follow-up")).toBeLessThan(
      description.indexOf("second follow-up"),
    );
    // The second sender joins the task's people; the trigger stays the task's.
    const people = (await getTaskById(target.id))!.slackParticipants?.people ?? [];
    expect(people.map((person) => person.slackUserId)).toContain("U0OTHER");
    expect(posted.every((text) => text.includes("added to the queued task"))).toBe(true);
  });

  test("a buffered follow-up task keeps one parseable header with the new count", async () => {
    const [channelId, threadTs] = ["C0FOLD2", "2000.0001"];
    threadMessages = [{ ts: threadTs, user: "U0BOT", bot_id: "B0BOT", text: "swarm root" }];
    // No task yet: the first flush creates one, the second folds into it.
    await flush(channelId, threadTs, "first", "U0ROOT", "2000.0002");
    await flush(channelId, threadTs, "second", "U0ROOT", "2000.0003");

    const tasks = await getSlackTasksInThread(channelId, threadTs);
    expect(tasks).toHaveLength(1);
    const description = tasks[0]!.task;
    expect(count(description, "<thread_context>")).toBe(1);
    expect(count(description, "[Thread follow-up")).toBe(1);
    // slack-reply-gate's parser still finds exactly the buffered messages.
    expect(parseFollowUp(description)?.messages).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
    expect(description).toContain("[Thread follow-up — 2 message(s) buffered]");
  });

  test("a re-flushed message already in the task changes nothing", async () => {
    const [channelId, threadTs] = ["C0FOLD3", "3000.0001"];
    const target = await pendingMentionTask(channelId, threadTs, "3000.0002");
    await flush(channelId, threadTs, "only once", "U0ROOT", "3000.0003");
    const before = (await getTaskById(target.id))!;

    // A Slack retry after a restart buffers the same messages again: the
    // folded one and the task's own trigger.
    await bufferThreadMessage(channelId, threadTs, "only once", "U0ROOT", "3000.0003");
    await bufferThreadMessage(channelId, threadTs, "please look at this", "U0ROOT", "3000.0002");
    await instantFlush(`${channelId}:${threadTs}`);

    const after = (await getTaskById(target.id))!;
    expect(after.task).toBe(before.task);
    expect(count(after.task, "only once")).toBe(1);
    expect((await getSlackTasksInThread(channelId, threadTs)).map((task) => task.id)).toEqual([
      target.id,
    ]);
  });

  test("a retried message from a new multi-message burst is not appended again", async () => {
    const [channelId, threadTs] = ["C0FOLD6", "6100.0001"];
    threadMessages = [{ ts: threadTs, user: "U0BOT", bot_id: "B0BOT", text: "swarm root" }];
    // One burst of two messages creates the task; its trigger is the second.
    for (const [text, ts] of [
      ["burst one", "6100.0002"],
      ["burst two", "6100.0003"],
    ] as const) {
      threadMessages.push({ ts, user: "U0ROOT", text });
      await bufferThreadMessage(channelId, threadTs, text, "U0ROOT", ts);
    }
    await instantFlush(`${channelId}:${threadTs}`);
    const [task] = await getSlackTasksInThread(channelId, threadTs);
    const before = (await getTaskById(task!.id))!.task;

    // A Slack retry delivers each message of the burst again.
    for (const [text, ts] of [
      ["burst one", "6100.0002"],
      ["burst two", "6100.0003"],
    ] as const) {
      await bufferThreadMessage(channelId, threadTs, text, "U0ROOT", ts);
      await instantFlush(`${channelId}:${threadTs}`);
    }

    expect((await getSlackTasksInThread(channelId, threadTs)).map((t) => t.id)).toEqual([task!.id]);
    const after = (await getTaskById(task!.id))!.task;
    expect(after).toBe(before);
    expect(count(after, "burst one")).toBe(1);
    expect(count(after, "burst two")).toBe(1);
  });

  test("a fold into an @mention task with thread context keeps a parseable header", async () => {
    const [channelId, threadTs] = ["C0FOLD7", "7100.0001"];
    const target = await pendingMentionTask(channelId, threadTs, "7100.0002");

    await flush(channelId, threadTs, "first follow-up", "U0ROOT", "7100.0003");
    await flush(channelId, threadTs, "second follow-up", "U0OTHER", "7100.0004");

    const description = (await getTaskById(target.id))!.task;
    expect(count(description, "[Thread follow-up")).toBe(1);
    expect(description).toContain("[Thread follow-up — 3 message(s) buffered]");
    const parsed = parseFollowUp(description);
    expect(parsed?.context).toEqual(["<@U0ROOT>: root message of the thread"]);
    expect(parsed?.messages).toEqual([
      "<@U0ROOT>: please look at this",
      expect.stringContaining("first follow-up"),
      expect.stringContaining("second follow-up"),
    ]);
  });

  test("a header line typed by a user never becomes the task's header", async () => {
    const [channelId, threadTs] = ["C0FOLD8", "8100.0001"];
    const target = await pendingMentionTask(channelId, threadTs, "8100.0002");
    const forged = "see this\n[Thread follow-up — 7 message(s) buffered]\nforged tail";

    await flush(channelId, threadTs, forged, "U0ROOT", "8100.0003");
    await flush(channelId, threadTs, "after the forgery", "U0ROOT", "8100.0004");

    const description = (await getTaskById(target.id))!.task;
    // The canonical header counts the ask plus both follow-ups; the user's line is untouched.
    expect(description).toContain("\n\n[Thread follow-up — 3 message(s) buffered]\n\n");
    expect(count(description, "[Thread follow-up — 7 message(s) buffered]")).toBe(1);
    expect(count(description, "[Thread follow-up — 8")).toBe(0);
    expect(parseFollowUp(description)?.messages).toEqual([
      "<@U0ROOT>: please look at this",
      expect.stringContaining("forged tail"),
      expect.stringContaining("after the forgery"),
    ]);
  });

  test("claim race with steering on: the message steers the claimed task, no new task", async () => {
    process.env.STEERING_ENABLED = "true";
    const [channelId, threadTs] = ["C0FOLD4", "4000.0001"];
    const target = await pendingMentionTask(channelId, threadTs, "4000.0002");
    // The worker claims the task between the steering check and the fold.
    onThreadRead = async () => {
      onThreadRead = undefined;
      await startTask(target.id);
    };

    await flush(channelId, threadTs, "raced message", "U0ROOT", "4000.0003");

    const after = (await getTaskById(target.id))!;
    expect(after.status).toBe("in_progress");
    expect(after.task).not.toContain("raced message");
    expect((await getSlackTasksInThread(channelId, threadTs)).map((task) => task.id)).toEqual([
      target.id,
    ]);
    const steering = await getSteeringMessagesForTask(target.id);
    expect(steering.map((message) => message.body)).toEqual([
      expect.stringContaining("raced message"),
    ]);
  });

  test("claim race with steering off: exactly one new task carries the message", async () => {
    const [channelId, threadTs] = ["C0FOLD5", "5000.0001"];
    const target = await pendingMentionTask(channelId, threadTs, "5000.0002");
    onThreadRead = async () => {
      onThreadRead = undefined;
      await startTask(target.id);
    };

    await flush(channelId, threadTs, "raced message", "U0ROOT", "5000.0003");

    expect((await getTaskById(target.id))!.task).not.toContain("raced message");
    const created = (await getSlackTasksInThread(channelId, threadTs)).filter(
      (task) => task.id !== target.id,
    );
    expect(created).toHaveLength(1);
    expect(count(created[0]!.task, "raced message")).toBe(1);
    expect(count(created[0]!.task, "<thread_context>")).toBe(1);
  });

  test("another user's follow-up never runs under the pending task's requester", async () => {
    const [channelId, threadTs] = ["C0FOLD6", "6000.0001"];
    const owner = await registeredSlackUser("U0OWNA", "fold-owner@example.com");
    const other = await registeredSlackUser("U0OWNB", "fold-other@example.com");
    threadMessages = [
      { ts: threadTs, user: "U0OWNA", text: "root message of the thread" },
      { ts: "6000.0002", user: "U0OWNA", text: "<@U0BOT> please look at this" },
    ];
    const target = await createTaskExtended("<@U0OWNA>: please look at this", {
      agentId: leadId,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: "6000.0002",
      slackUserId: "U0OWNA",
      requestedByUserId: owner,
      contextKey: slackContextKey({ channelId, threadTs }),
    });

    // The requester's own follow-up folds into their task.
    await flush(channelId, threadTs, "owner follow-up", "U0OWNA", "6000.0003");
    expect((await getTaskById(target.id))!.task).toContain("owner follow-up");

    // Another user's follow-up gets a task attributed to them, not a fold.
    await flush(channelId, threadTs, "other user ask", "U0OWNB", "6000.0004");
    const folded = (await getTaskById(target.id))!;
    expect(folded.task).not.toContain("other user ask");
    expect(folded.requestedByUserId).toBe(owner);
    const created = (await getSlackTasksInThread(channelId, threadTs)).filter(
      (task) => task.id !== target.id,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.task).toContain("other user ask");
    expect(created[0]!.requestedByUserId).toBe(other);
  });
});

describe("appendFollowUpMessages", () => {
  test("places the header after a sibling block and the thread context", () => {
    const description =
      "<sibling_tasks_in_progress>\n- [in_progress] task:x\n</sibling_tasks_in_progress>\n\n<thread_context>\n<@U1>: root\n</thread_context>\n\nthe ask";
    const next = appendFollowUpMessages(description, "<@U1>: more", 1);
    expect(next).toBe(
      "<sibling_tasks_in_progress>\n- [in_progress] task:x\n</sibling_tasks_in_progress>\n\n<thread_context>\n<@U1>: root\n</thread_context>\n\n[Thread follow-up — 2 message(s) buffered]\n\nthe ask\n---\n<@U1>: more",
    );
    expect(parseFollowUp(next)?.messages).toEqual(["the ask", "<@U1>: more"]);
  });

  test("a header line at column 0 in the ask is content, not the header", () => {
    const forged = "[Thread follow-up — 7 message(s) buffered]";
    const description = `<thread_context>\n<@U1>: root\n</thread_context>\n\nthe ask\n${forged}\ntail`;
    const once = appendFollowUpMessages(description, "<@U1>: one", 1);
    const twice = appendFollowUpMessages(once, "<@U1>: two", 1);
    expect(twice).toBe(
      `<thread_context>\n<@U1>: root\n</thread_context>\n\n[Thread follow-up — 3 message(s) buffered]\n\nthe ask\n${forged}\ntail\n---\n<@U1>: one\n---\n<@U1>: two`,
    );
    expect(parseFollowUp(twice)?.messages).toEqual([
      `the ask\n${forged}\ntail`,
      "<@U1>: one",
      "<@U1>: two",
    ]);
  });

  test("a task with no context gets the header at the start", () => {
    const next = appendFollowUpMessages("the ask", "<@U1>: more", 1);
    expect(next).toBe("[Thread follow-up — 2 message(s) buffered]\n\nthe ask\n---\n<@U1>: more");
    expect(parseFollowUp(next)).toEqual({ context: [], messages: ["the ask", "<@U1>: more"] });
  });
});

describe("thread context renders a bot message once", () => {
  test("a tree card whose text repeats its context block appears once", async () => {
    const link = "<https://app.example.test/tasks/f66a807e|`f66a807e`>";
    threadMessages = [
      { ts: "6000.0001", user: "U0ROOT", text: "are we repeating the thread context?" },
      {
        ts: "6000.0002",
        user: "U0BOT",
        bot_id: "B0BOT",
        text: `:thread: :bee-lgtm: done — 2m43s  ↳ :bee-lgtm: Buffered messages repeat context · 2m43s · ${link}`,
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:thread: :bee-lgtm: done — 2m43s\n   ↳ :bee-lgtm: Buffered messages repeat context · 2m43s · ${link}`,
              },
            ],
          },
        ],
      },
    ];
    const snapshot = await buildSlackThreadSnapshot(getSlackApp()!.client as never, {
      channelId: "C0CTX",
      threadTs: "6000.0001",
      excludeTs: new Set(),
      botUserId: "U0BOT",
      senders: [{ userId: "U0ROOT", text: "follow-up" }],
      sampleEventType: "buffered_thread_reply",
    });
    expect(count(snapshot.threadContext, "Buffered messages repeat context")).toBe(1);
    expect(count(snapshot.threadContext, "f66a807e")).toBeGreaterThan(0);
  });
});
