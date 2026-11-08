import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getSlackTasksInThread,
  initDb,
  upsertKv,
} from "../be/db";
import { slackContextKey } from "../tasks/context-key";

process.env.SLACK_RENDER_V2 = "false";
// No timer flush during a test: each one flushes what it buffers with instantFlush.
process.env.ADDITIVE_SLACK_BUFFER_MS = "600000";

const TEST_DB_PATH = `/tmp/agent-swarm-slack-thread-buffer-restore-${process.pid}.sqlite`;
const previousSteeringEnabled = process.env.STEERING_ENABLED;

const realSlackApp = await import("../slack/app");
mock.module("../slack/app", () => ({
  ...realSlackApp,
  getSlackApp: () => ({
    client: {
      conversations: { replies: async () => ({ ok: true, messages: [] }) },
      users: { info: async () => ({ ok: true, user: { profile: {} } }) },
      reactions: { add: async () => ({ ok: true }) },
      chat: { postMessage: async () => ({ ok: true, ts: "9999.0001" }) },
    },
  }),
}));

// Makes the flush throw after the buffer handed it the batch.
let failFlush = false;
const realSlackFold = await import("../be/db/tasks/slack-fold");
// mock.module rewrites the live namespace, so keep the real function first.
const realGetDelivered = realSlackFold.getDeliveredSlackMessageTs;
mock.module("../be/db/tasks/slack-fold", () => ({
  ...realSlackFold,
  getDeliveredSlackMessageTs: async (channelId: string, threadTs: string) => {
    if (failFlush) throw new Error("flush failed");
    return realGetDelivered(channelId, threadTs);
  },
}));

const {
  bufferThreadMessage,
  getBufferMessageCount,
  instantFlush,
  isThreadBuffered,
  resetSlackBufferRestoreForTests,
  restoreBufferedSlackMessages,
} = await import("../slack/thread-buffer");
const store = await import("../slack/thread-buffer-store");

beforeAll(async () => {
  process.env.STEERING_ENABLED = "false";
  initDb(TEST_DB_PATH);
  // The flush routes new tasks to the Lead.
  await createAgent({
    name: "restore-lead",
    isLead: true,
    status: "idle",
    capabilities: [],
    harnessProvider: "pi",
  });
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

beforeEach(async () => {
  failFlush = false;
  await store.clear(await store.loadAll());
  resetSlackBufferRestoreForTests();
});

function message(channelId: string, threadTs: string, ts: string, text: string) {
  return { text, userId: "U0HUMAN", ts, channelId, threadTs };
}

/** A previous process buffered these and died before the flush. */
async function persistedBeforeRestart(...items: ReturnType<typeof message>[]) {
  for (const item of items) await store.persist(item);
}

describe("Slack thread buffer survives a restart", () => {
  test("a buffered message is stored until its flush returns", async () => {
    const [channelId, threadTs] = ["C0REST1", "1000.0001"];
    await bufferThreadMessage(channelId, threadTs, "please check", "U0HUMAN", "1000.0002");

    expect(await store.loadAll()).toEqual([
      expect.objectContaining({ channelId, threadTs, ts: "1000.0002", text: "please check" }),
    ]);

    await instantFlush(`${channelId}:${threadTs}`);

    expect(await store.loadAll()).toEqual([]);
    expect(await getSlackTasksInThread(channelId, threadTs)).toHaveLength(1);
  });

  test("restored messages re-buffer per thread and flush into one task", async () => {
    const [channelId, threadTs] = ["C0REST2", "2000.0001"];
    await persistedBeforeRestart(
      message(channelId, threadTs, "2000.0003", "second reply"),
      message(channelId, threadTs, "2000.0002", "first reply"),
      message("C0OTHER", "2100.0001", "2100.0002", "other thread"),
    );

    expect(await restoreBufferedSlackMessages()).toBe(3);
    expect(getBufferMessageCount(`${channelId}:${threadTs}`)).toBe(2);
    expect(isThreadBuffered("C0OTHER", "2100.0001")).toBe(true);
    // Restoring does not write the rows again, and runs once per process.
    expect(await store.loadAll()).toHaveLength(3);
    expect(await restoreBufferedSlackMessages()).toBe(0);
    expect(getBufferMessageCount(`${channelId}:${threadTs}`)).toBe(2);

    await instantFlush(`${channelId}:${threadTs}`);
    await instantFlush("C0OTHER:2100.0001");

    const tasks = await getSlackTasksInThread(channelId, threadTs);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task.indexOf("first reply")).toBeLessThan(
      tasks[0]!.task.indexOf("second reply"),
    );
    expect(await store.loadAll()).toEqual([]);
  });

  test("a flush that throws keeps the rows for the next boot", async () => {
    const [channelId, threadTs] = ["C0REST3", "3000.0001"];
    await bufferThreadMessage(channelId, threadTs, "do not lose me", "U0HUMAN", "3000.0002");
    failFlush = true;
    await instantFlush(`${channelId}:${threadTs}`);

    expect(isThreadBuffered(channelId, threadTs)).toBe(false);
    expect(await store.loadAll()).toHaveLength(1);

    failFlush = false;
    expect(await restoreBufferedSlackMessages()).toBe(1);
    await instantFlush(`${channelId}:${threadTs}`);

    const tasks = await getSlackTasksInThread(channelId, threadTs);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toContain("do not lose me");
    expect(await store.loadAll()).toEqual([]);
  });

  test("an expired row is not restored", async () => {
    const [channelId, threadTs] = ["C0REST4", "4000.0001"];
    await upsertKv({
      namespace: store.SLACK_THREAD_BUFFER_KV_NAMESPACE,
      key: `${channelId}:${threadTs}:4000.0002`,
      value: message(channelId, threadTs, "4000.0002", "too old"),
      valueType: "json",
      expiresAt: Date.now() - 1,
    });

    expect(await restoreBufferedSlackMessages()).toBe(0);
    expect(isThreadBuffered(channelId, threadTs)).toBe(false);
  });

  test("a replayed message a task already carries creates no second task", async () => {
    const [channelId, threadTs] = ["C0REST5", "5000.0001"];
    const worker = await createAgent({
      name: "restore-worker",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "pi",
    });
    // The previous process created this task, then died before deleting the row.
    // A worker's task is no fold target, so only the delivered-ts check stops a second task.
    await createTaskExtended("<@U0HUMAN>: already delivered", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: "5000.0002",
      slackUserId: "U0HUMAN",
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await persistedBeforeRestart(message(channelId, threadTs, "5000.0002", "already delivered"));

    expect(await restoreBufferedSlackMessages()).toBe(1);
    await instantFlush(`${channelId}:${threadTs}`);

    expect(await getSlackTasksInThread(channelId, threadTs)).toHaveLength(1);
    expect(await store.loadAll()).toEqual([]);
  });
});
