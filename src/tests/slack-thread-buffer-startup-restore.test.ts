import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pollUntil } from "../../scripts/e2e/http";
import { type SlackHarness, startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { closeDb, createAgent, getSlackTasksInThread, initDb } from "../be/db";

// No timer flush during the test: it flushes the restored thread with instantFlush.
process.env.ADDITIVE_SLACK_BUFFER_MS = "600000";
process.env.SLACK_RENDER_V2 = "false";

const { startSlackApp, stopSlackApp } = await import("../slack/app");
const { runSlackLifecycleExclusive } = await import("../slack/lifecycle-lock");
const { instantFlush, isThreadBuffered, resetSlackBufferRestoreForTests } = await import(
  "../slack/thread-buffer"
);
const store = await import("../slack/thread-buffer-store");

let slack: SlackHarness;
const saved = { ...process.env };

beforeAll(async () => {
  slack = await startSlackMock(false);
  initDb(":memory:");
  Object.assign(process.env, slack.mock.env);
  process.env.SLACK_DISABLE = "false";
  process.env.SLACK_MODE = "socket";
  process.env.STEERING_ENABLED = "false";
  // A file sharing this process may already have run the once-per-process restore.
  resetSlackBufferRestoreForTests();
  // The flush routes new tasks to the Lead.
  await createAgent({
    name: "startup-restore-lead",
    isLead: true,
    status: "idle",
    capabilities: [],
    harnessProvider: "pi",
  });
});

afterAll(async () => {
  await stopSlackApp();
  process.env = saved;
  await stopSlackMock(slack, false);
  closeDb();
});

describe("Slack startup restores the thread buffer", () => {
  test("a reply persisted before the restart becomes one task after Slack connects", async () => {
    // The thread exists in Slack; the previous process buffered the reply and
    // died before the flush. Seeded straight into the store: no event reaches the app.
    const human = slack.mock.addUser({ name: "restart-human" });
    const channelId = slack.mock.addChannel({ name: "boot-restore", withBot: true }).id;
    const root = slack.mock.store.addMessage({ channel: channelId, user: human.id, text: "root" });
    const threadTs = root.ts;
    const reply = slack.mock.store.addMessage({
      channel: channelId,
      user: human.id,
      text: "reply from before the restart",
      thread_ts: threadTs,
    });
    await store.persist({
      text: reply.text,
      userId: human.id,
      ts: reply.ts,
      channelId,
      threadTs,
    });
    expect(isThreadBuffered(channelId, threadTs)).toBe(false);

    expect(await runSlackLifecycleExclusive(() => startSlackApp())).toBe(true);
    await slack.mock.waitForConnection(10_000);

    // Nothing but the boot path re-buffers the row.
    expect(await pollUntil(() => isThreadBuffered(channelId, threadTs), 5_000, 25)).toBe(true);
    await instantFlush(`${channelId}:${threadTs}`);

    const tasks = await getSlackTasksInThread(channelId, threadTs);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.task).toContain("reply from before the restart");
    expect(await store.loadAll()).toEqual([]);
  }, 30_000);
});
