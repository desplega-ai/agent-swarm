import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  ensureSlackRenderV2Activation,
  failTask,
  getDb,
  getSlackOutcomeMessage,
  getSlackRenderV2ActivatedAt,
  getSlackTreeMessage,
  getSlackTreeMessageByThread,
  getSlackTreeMessages,
  getTaskById,
  initDb,
  isPendingSlackMessage,
  startTask,
} from "../be/db";
import { getTaskLink, MAX_SECTION_LENGTH } from "../slack/blocks";
import {
  _resetSlackRenderV2ForTests,
  callSlackWithRetry,
  ensureSlackThreadTree,
  formatV2Duration,
  isSlackRenderV2Enabled,
  processSlackRenderV2,
  renderThreadTree,
} from "../slack/render-v2";
import { slackContextKey } from "../tasks/context-key";

const TEST_DB_PATH = "./test-slack-render-v2.sqlite";
const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
let treeCounter = 0;
let outcomeCounter = 0;
let appendCallsUntilFailure: number | undefined;
let permalinkFailuresRemaining = 0;
let slackAddressSequence = 0;
let missingMessageTs: string | undefined;
let updateFailuresRemaining = 0;
let disableRenderAfterMethod: string | undefined;

type RemoteMessage = {
  channel: string;
  threadTs: string;
  ts: string;
  text: string;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
  streaming?: boolean;
};

const remoteMessages = new Map<string, RemoteMessage>();

function remoteKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await Bun.sleep(5);
  }
}

let nextUpdateBarrier:
  | { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }
  | undefined;

function uniqueSlackAddress(label: string): { channelId: string; threadTs: string } {
  slackAddressSequence++;
  return {
    channelId: `${label}_${slackAddressSequence}`,
    threadTs: `${slackAddressSequence}.1`,
  };
}

const mockApiCall = mock(async (method: string, payload: Record<string, unknown>) => {
  calls.push({ method, payload });
  if (method === disableRenderAfterMethod) {
    disableRenderAfterMethod = undefined;
    process.env.SLACK_RENDER_V2 = "false";
  }
  if (method === "conversations.replies") {
    const includeAllMetadata = payload.include_all_metadata === true;
    return {
      ok: true,
      messages: [...remoteMessages.values()]
        .filter((message) => message.channel === payload.channel && message.threadTs === payload.ts)
        .map((message) => ({
          ...message,
          metadata: message.metadata
            ? {
                event_type: message.metadata.event_type,
                ...(includeAllMetadata ? { event_payload: message.metadata.event_payload } : {}),
              }
            : undefined,
        })),
      response_metadata: { next_cursor: "" },
    };
  }
  if (method === "chat.postMessage") {
    const ts = `tree.${++treeCounter}`;
    remoteMessages.set(remoteKey(String(payload.channel), ts), {
      channel: String(payload.channel),
      threadTs: String(payload.thread_ts),
      ts,
      text: String(payload.text ?? ""),
      metadata: payload.metadata as RemoteMessage["metadata"],
    });
    return { ok: true, ts };
  }
  if (method === "chat.startStream") {
    const ts = `outcome.${++outcomeCounter}`;
    remoteMessages.set(remoteKey(String(payload.channel), ts), {
      channel: String(payload.channel),
      threadTs: String(payload.thread_ts),
      ts,
      text: String(payload.markdown_text ?? ""),
      streaming: true,
    });
    return { ok: true, ts };
  }
  if (method === "chat.appendStream" && appendCallsUntilFailure !== undefined) {
    if (appendCallsUntilFailure === 0) {
      appendCallsUntilFailure = undefined;
      throw new Error("temporary append failure");
    }
    appendCallsUntilFailure--;
  }
  if (method === "chat.appendStream") {
    const message = remoteMessages.get(remoteKey(String(payload.channel), String(payload.ts)));
    if (!message) throw { data: { error: "message_not_found" } };
    message.text += String(payload.markdown_text ?? "");
    return { ok: true };
  }
  if (method === "chat.stopStream") {
    const message = remoteMessages.get(remoteKey(String(payload.channel), String(payload.ts)));
    if (!message) throw { data: { error: "message_not_found" } };
    if (!message.streaming) throw { data: { error: "message_not_in_streaming_state" } };
    message.streaming = false;
    return { ok: true };
  }
  if (method === "chat.getPermalink") {
    if (permalinkFailuresRemaining > 0) {
      permalinkFailuresRemaining--;
      throw new Error("temporary permalink failure");
    }
    if (
      missingMessageTs === payload.message_ts ||
      !remoteMessages.has(remoteKey(String(payload.channel), String(payload.message_ts)))
    ) {
      throw { data: { error: "message_not_found" } };
    }
    return {
      ok: true,
      permalink: `https://workspace.slack.com/archives/${payload.channel}/p${String(payload.message_ts).replaceAll(".", "")}`,
    };
  }
  if (method === "chat.update") {
    if (updateFailuresRemaining > 0) {
      updateFailuresRemaining--;
      throw new Error("temporary update failure");
    }
    if (missingMessageTs === payload.ts) throw { data: { error: "message_not_found" } };
    const message = remoteMessages.get(remoteKey(String(payload.channel), String(payload.ts)));
    if (!message) throw { data: { error: "message_not_found" } };
    const barrier = nextUpdateBarrier;
    if (barrier) {
      nextUpdateBarrier = undefined;
      barrier.started.resolve();
      await barrier.released.promise;
    }
    message.text = String(payload.text ?? "");
    return { ok: true };
  }
  if (method === "auth.test") return { ok: true, team_id: "T_TEST" };
  return { ok: true };
});

mock.module("../slack/app", () => ({
  getSlackApp: () => ({ client: { apiCall: mockApiCall } }),
}));

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

beforeAll(() => {
  process.env.APP_URL = "https://app.agent-swarm.dev";
  process.env.SLACK_RENDER_V2 = "true";
});

beforeEach(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  ensureSlackRenderV2Activation();
  calls.length = 0;
  remoteMessages.clear();
  treeCounter = 0;
  outcomeCounter = 0;
  mockApiCall.mockClear();
  appendCallsUntilFailure = undefined;
  permalinkFailuresRemaining = 0;
  missingMessageTs = undefined;
  updateFailuresRemaining = 0;
  disableRenderAfterMethod = undefined;
  nextUpdateBarrier = undefined;
  _resetSlackRenderV2ForTests();
});

afterAll(async () => {
  _resetSlackRenderV2ForTests();
  closeDb();
  await removeDbFiles();
});

describe("Slack renderer v2", () => {
  test("defaults off and accepts an explicit opt-in", () => {
    const previous = process.env.SLACK_RENDER_V2;
    delete process.env.SLACK_RENDER_V2;
    expect(isSlackRenderV2Enabled()).toBe(false);
    process.env.SLACK_RENDER_V2 = "true";
    expect(isSlackRenderV2Enabled()).toBe(true);
    if (previous === undefined) delete process.env.SLACK_RENDER_V2;
    else process.env.SLACK_RENDER_V2 = previous;
  });

  test("does not backfill historical Slack tasks when v2 is first enabled", async () => {
    const lead = createAgent({ name: "Upgrade Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_UPGRADE_HISTORY");
    const ask = createTaskExtended("historical ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    completeTask(ask.id, "This historical result must not be replayed.");
    getDb().run(`UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?`, [
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:01:00.000Z",
      ask.id,
    ]);
    getDb().run(`DELETE FROM slack_render_v2_state`);
    calls.length = 0;

    await processSlackRenderV2();

    expect(getSlackRenderV2ActivatedAt()).not.toBeNull();
    expect(getDb().query(`SELECT * FROM slack_messages`).all()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("reuses the persisted activation watermark after a restart", async () => {
    const testGlobals = globalThis as typeof globalThis & {
      __testMigrationTemplate?: Uint8Array;
    };
    const migrationTemplate = testGlobals.__testMigrationTemplate;
    closeDb();
    await removeDbFiles();
    delete testGlobals.__testMigrationTemplate;
    try {
      initDb(TEST_DB_PATH);
      const lead = createAgent({ name: "Restart Lead", isLead: true, status: "idle" });
      const { channelId, threadTs } = uniqueSlackAddress("C_RESTART_HISTORY");
      const ask = createTaskExtended("old ask before restart", {
        agentId: lead.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        contextKey: slackContextKey({ channelId, threadTs }),
      });
      startTask(ask.id);
      getDb().run(`UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?`, [
        "2025-02-01T00:00:00.000Z",
        "2025-02-01T00:01:00.000Z",
        ask.id,
      ]);

      await processSlackRenderV2();
      const firstActivation = getSlackRenderV2ActivatedAt();
      closeDb();
      initDb(TEST_DB_PATH);
      _resetSlackRenderV2ForTests();
      calls.length = 0;

      await processSlackRenderV2();

      expect(firstActivation).not.toBeNull();
      expect(getSlackRenderV2ActivatedAt()).toBe(firstActivation);
      expect(calls).toHaveLength(0);
    } finally {
      closeDb();
      if (migrationTemplate) testGlobals.__testMigrationTemplate = migrationTemplate;
      await removeDbFiles();
    }
  });

  test("keeps an accidental old tree active only for post-activation asks", async () => {
    const lead = createAgent({ name: "Existing Tree Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_EXISTING_TREE");
    const contextKey = slackContextKey({ channelId, threadTs });
    const oldAsk = createTaskExtended("old ask with an accidental tree", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    startTask(oldAsk.id);
    const tree = await ensureSlackThreadTree([oldAsk.id]);
    completeTask(oldAsk.id, "Old outcome must remain suppressed.");
    getDb().run(`UPDATE agent_tasks SET createdAt = ? WHERE id = ?`, [
      "2025-03-01T00:00:00.000Z",
      oldAsk.id,
    ]);
    getDb().run(`UPDATE slack_render_v2_state SET activated_at = ? WHERE id = 1`, [
      "2026-01-01T00:00:00.000Z",
    ]);
    const newAsk = createTaskExtended("new ask in the existing thread", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    startTask(newAsk.id);
    completeTask(newAsk.id, "Only this new outcome should be rendered.");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(getSlackTreeMessageByThread(channelId, threadTs)?.id).toBe(tree?.id);
    expect(getSlackOutcomeMessage(oldAsk.id)).toBeNull();
    expect(getSlackOutcomeMessage(newAsk.id)?.finalizedAt).toBeDefined();
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
  });

  test("does not verify an old missing outcome when new active work awakens its tree", async () => {
    const lead = createAgent({ name: "Active Existing Tree Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_ACTIVE_EXISTING_TREE");
    const contextKey = slackContextKey({ channelId, threadTs });
    const oldAsk = createTaskExtended("old terminal ask without an outcome", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    startTask(oldAsk.id);
    const tree = await ensureSlackThreadTree([oldAsk.id]);
    completeTask(oldAsk.id, "This old outcome must not trigger tree verification.");
    getDb().run(`UPDATE agent_tasks SET createdAt = ? WHERE id = ?`, [
      "2025-04-01T00:00:00.000Z",
      oldAsk.id,
    ]);
    getDb().run(`UPDATE slack_render_v2_state SET activated_at = ? WHERE id = 1`, [
      "2026-01-01T00:00:00.000Z",
    ]);
    const activeAsk = createTaskExtended("new active ask in the old thread", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    startTask(activeAsk.id);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.getPermalink")).toBe(false);
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    expect(getSlackTreeMessageByThread(channelId, threadTs)?.id).toBe(tree?.id);
    expect(getSlackOutcomeMessage(oldAsk.id)).toBeNull();
  });

  test("stops an in-flight discovery pass after v2 is disabled", async () => {
    const lead = createAgent({ name: "Kill Switch Lead", isLead: true, status: "idle" });
    for (const label of ["first", "second"]) {
      const { channelId, threadTs } = uniqueSlackAddress(`C_KILL_${label}`);
      const ask = createTaskExtended(`${label} ask`, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        contextKey: slackContextKey({ channelId, threadTs }),
      });
      startTask(ask.id);
    }
    disableRenderAfterMethod = "chat.postMessage";

    try {
      await processSlackRenderV2();
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
      expect(getDb().query(`SELECT * FROM slack_messages WHERE kind = 'tree'`).all()).toHaveLength(
        1,
      );
    } finally {
      process.env.SLACK_RENDER_V2 = "true";
    }
  });

  test("retries Slack rate limits using the advertised backoff", async () => {
    const apiCall = mock()
      .mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 0 })
      .mockResolvedValueOnce({ ok: true, ts: "retried.1" });

    const result = await callSlackWithRetry(
      { apiCall } as unknown as Parameters<typeof callSlackWithRetry>[0],
      "chat.update",
      { channel: "C_RETRY", ts: "1.1", text: "updated" },
    );

    expect(result.ts).toBe("retried.1");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  test("persists the tree timestamp before permalink resolution and reuses it on retry", async () => {
    const lead = createAgent({ name: "Permalink Lead", isLead: true, status: "idle" });
    const channelId = "C_TREE_PERMALINK";
    const threadTs = "150.1";
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = createTaskExtended("permalink recovery", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    permalinkFailuresRemaining = 1;

    await expect(ensureSlackThreadTree([ask.id])).rejects.toThrow("temporary permalink failure");
    const persisted = getSlackTreeMessage(contextKey);
    expect(persisted?.ts).toBeDefined();
    expect(persisted?.permalink).toBeUndefined();
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(calls.find((call) => call.method === "chat.postMessage")?.payload).toMatchObject({
      unfurl_links: false,
      unfurl_media: false,
    });

    calls.length = 0;
    const recovered = await ensureSlackThreadTree([ask.id]);
    expect(recovered?.ts).toBe(persisted?.ts);
    expect(recovered?.permalink).toContain("workspace.slack.com");
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    _resetSlackRenderV2ForTests();
  });

  test("reconciles a tree accepted before its timestamp bind without reposting", async () => {
    const lead = createAgent({ name: "Tree Crash Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_BIND_CRASH");
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = createTaskExtended("survive tree bind crash", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    startTask(ask.id);
    getDb().run(`CREATE TRIGGER fail_tree_timestamp_bind
      BEFORE UPDATE OF ts ON slack_messages
      WHEN OLD.kind = 'tree' AND OLD.ts LIKE 'pending:%'
      BEGIN SELECT RAISE(ABORT, 'simulated tree bind crash'); END`);

    await expect(ensureSlackThreadTree([ask.id])).rejects.toThrow("simulated tree bind crash");
    const pending = getSlackTreeMessage(contextKey)!;
    expect(isPendingSlackMessage(pending)).toBe(true);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(
      [...remoteMessages.values()].filter((message) => message.channel === channelId),
    ).toHaveLength(1);

    getDb().run("DROP TRIGGER fail_tree_timestamp_bind");
    completeTask(ask.id, "The tree state changed while its timestamp was not bound.");
    calls.length = 0;
    const recovered = await ensureSlackThreadTree([ask.id]);

    expect(isPendingSlackMessage(recovered!)).toBe(false);
    expect(recovered?.id).toBe(pending.id);
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    const replies = calls.find((call) => call.method === "conversations.replies");
    expect(replies?.payload.include_all_metadata).toBe(true);
    expect(calls.find((call) => call.method === "chat.update")?.payload).toMatchObject({
      unfurl_links: false,
      unfurl_media: false,
    });
    const remote = remoteMessages.get(remoteKey(channelId, recovered!.ts));
    expect(remote?.text).toContain("✅");
    expect(
      [...remoteMessages.values()].filter((message) => message.channel === channelId),
    ).toHaveLength(1);
  });

  test("reuses the physical thread tree when a later task has a different context key", async () => {
    const lead = createAgent({ name: "Thread Identity Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_THREAD_IDENTITY");
    const first = createTaskExtended("first context", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:first:${channelId}`,
    });
    const second = createTaskExtended("second context", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:second:${channelId}`,
    });

    const [tree, reused] = await Promise.all([
      ensureSlackThreadTree([first.id]),
      ensureSlackThreadTree([second.id]),
    ]);

    expect(reused?.id).toBe(tree?.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    failTask(first.id, "test cleanup");
    failTask(second.id, "test cleanup");
  });

  test("formats compact elapsed time without spaces", () => {
    const start = new Date("2026-07-31T20:00:00.000Z");
    expect(formatV2Duration(start, new Date("2026-07-31T20:07:51.000Z"))).toBe("7m51s");
    expect(formatV2Duration(start, new Date("2026-07-31T20:16:01.000Z"))).toBe("16m01s");
    expect(formatV2Duration(start, new Date("2026-07-31T20:12:00.000Z"))).toBe("12m");
  });

  test("renders asks as thread roots and preserves real delegated nesting", () => {
    const lead = createAgent({ name: "Lead", isLead: true, status: "idle" });
    const researcher = createAgent({ name: "Researcher", isLead: false, status: "idle" });
    const contextKey = slackContextKey({ channelId: "C_TREE_SHAPE", threadTs: "100.1" });
    const ask = createTaskExtended("format tests", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_TREE_SHAPE",
      slackThreadTs: "100.1",
      contextKey,
    });
    const child = createTaskExtended("research exact Slack API behavior", {
      agentId: researcher.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const grandchild = createTaskExtended("verify payload", {
      agentId: researcher.id,
      source: "mcp",
      parentTaskId: child.id,
      followUpConfig: { disabled: true },
    });
    const secondAsk = createTaskExtended("this PR", {
      agentId: lead.id,
      source: "slack",
      parentTaskId: grandchild.id,
      slackChannelId: "C_TREE_SHAPE",
      slackThreadTs: "100.1",
      contextKey,
    });
    const fixedStart = new Date("2026-07-31T20:00:00.000Z").toISOString();
    const now = new Date("2026-07-31T20:08:05.000Z");
    const text = renderThreadTree(
      [ask, child, grandchild, secondAsk].map((task) => ({ ...task, createdAt: fixedStart })),
      new Map(),
      now,
    );

    expect(text).toBe(
      [
        "🧵 *format tests* · 8m05s",
        `↳ ⏳ format tests · 8m05s · <https://app.agent-swarm.dev/tasks/${ask.id}|\`${ask.id.slice(0, 8)}\`>`,
        `   ↳ ⏳ Researcher · 8m05s · <https://app.agent-swarm.dev/tasks/${child.id}|\`${child.id.slice(0, 8)}\`>`,
        `      ↳ ⏳ Researcher · 8m05s · <https://app.agent-swarm.dev/tasks/${grandchild.id}|\`${grandchild.id.slice(0, 8)}\`>`,
        `↳ ⏳ this PR · 8m05s · <https://app.agent-swarm.dev/tasks/${secondAsk.id}|\`${secondAsk.id.slice(0, 8)}\`>`,
      ].join("\n"),
    );
    expect(text).not.toContain("```");
  });

  test("collapses older tasks before a persistent tree exceeds Slack's section limit", async () => {
    const lead = createAgent({ name: "Overflow Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_OVERFLOW");
    const tasks = Array.from({ length: 80 }, (_, index) =>
      createTaskExtended(`overflow task ${index} ${"x".repeat(60)}`, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        contextKey: slackContextKey({ channelId, threadTs }),
      }),
    );

    await ensureSlackThreadTree([tasks.at(-1)!.id]);

    const posted = calls.find(
      (call) => call.method === "chat.postMessage" && call.payload.channel === channelId,
    )!;
    const text = posted.payload.text as string;
    const blocks = posted.payload.blocks as Array<{ text: { text: string } }>;
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_LENGTH);
    expect(blocks[0]?.text.text).toBe(text);
    expect(text).toContain("older tasks collapsed");
    expect(text).toContain(tasks.at(-1)!.id.slice(0, 8));
    expect(text).not.toContain(tasks[1]!.id.slice(0, 8));
    expect(text.split("\n").filter((line) => line.startsWith("↳"))).not.toHaveLength(0);
    expect(text).not.toMatch(/[├└│]/);

    for (const task of tasks) failTask(task.id, "test cleanup");
  });

  test("caps a pathological tree line and keeps the newest task in valid sections", async () => {
    const lead = createAgent({ name: "Pathological Lead", isLead: true, status: "idle" });
    const worker = createAgent({
      name: `Worker ${"x".repeat(5_000)}`,
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_LONG_LINE");
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = createTaskExtended("pathological tree line", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    const child = createTaskExtended("render the long worker label", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
      followUpConfig: { disabled: true },
    });

    await ensureSlackThreadTree([child.id]);

    const posted = calls.find((call) => call.method === "chat.postMessage")!;
    const blocks = posted.payload.blocks as Array<{ text: { text: string } }>;
    expect(blocks.every((block) => block.text.text.length <= MAX_SECTION_LENGTH)).toBe(true);
    expect(blocks.map((block) => block.text.text).join("\n")).toContain(child.id.slice(0, 8));
  });

  test("discovers an ask that completed before the first poll and emits one tree and card", async () => {
    const lead = createAgent({ name: "Fast Terminal Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_FAST_TERMINAL");
    const ask = createTaskExtended("finish before renderer poll", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    completeTask(ask.id, "Finished before the renderer observed the in-progress state.");

    await processSlackRenderV2();

    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
    expect(calls.some((call) => call.method === "conversations.replies")).toBe(false);
    expect(getSlackTreeMessageByThread(channelId, threadTs)).not.toBeNull();
    expect(getSlackOutcomeMessage(ask.id)?.finalizedAt).toBeDefined();
  });

  test("reconciles a started outcome before its timestamp bind without a duplicate stream", async () => {
    const lead = createAgent({ name: "Outcome Crash Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_OUTCOME_BIND_CRASH");
    const ask = createTaskExtended("survive outcome bind crash", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    completeTask(ask.id, "Recover this outcome through its deterministic task link.");
    getDb().run(`CREATE TRIGGER fail_outcome_timestamp_bind
      BEFORE UPDATE OF ts ON slack_messages
      WHEN OLD.kind = 'outcome' AND OLD.ts LIKE 'pending:%'
      BEGIN SELECT RAISE(ABORT, 'simulated outcome bind crash'); END`);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const pending = getSlackOutcomeMessage(ask.id)!;
    expect(isPendingSlackMessage(pending)).toBe(true);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
    const firstChunk = calls.find((call) => call.method === "chat.startStream")?.payload
      .markdown_text;
    expect(typeof firstChunk).toBe("string");
    expect(remoteMessages.get(remoteKey(channelId, `outcome.${outcomeCounter}`))?.text).toBe(
      firstChunk,
    );
    getDb().run("DROP TRIGGER fail_outcome_timestamp_bind");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    expect(calls.some((call) => call.method === "conversations.replies")).toBe(true);
    expect(getSlackOutcomeMessage(ask.id)?.id).toBe(pending.id);
    expect(getSlackOutcomeMessage(ask.id)?.finalizedAt).toBeDefined();
    expect(
      [...remoteMessages.values()].filter(
        (message) => message.channel === channelId && message.ts.startsWith("outcome."),
      ),
    ).toHaveLength(1);
  });

  test("reuses one persisted tree and streams one immutable outcome before linking it", async () => {
    const lead = createAgent({ name: "Lead v2", isLead: true, status: "idle" });
    const worker = createAgent({ name: "Researcher v2", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_V2");
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = createTaskExtended("ship Slack renderer", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_REQUESTER",
      contextKey,
    });
    const child = createTaskExtended("research implementation", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    startTask(ask.id);
    startTask(child.id);

    const firstTree = await ensureSlackThreadTree([ask.id, child.id]);
    expect(firstTree?.kind).toBe("tree");
    expect(getSlackTreeMessage(contextKey)?.ts).toBe(firstTree?.ts);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);

    const secondAsk = createTaskExtended("follow-up ask", {
      agentId: lead.id,
      source: "slack",
      parentTaskId: ask.id,
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_REQUESTER",
      contextKey,
    });
    const reusedTree = await ensureSlackThreadTree([secondAsk.id]);
    expect(reusedTree?.id).toBe(firstTree?.id);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);

    completeTask(child.id, "PRIVATE RAW WORKER OUTPUT THAT MUST NOT REACH SLACK");
    completeTask(
      ask.id,
      "Implemented the Slack renderer and opened a focused pull request.\n\nInternal details that should not be relayed.",
    );
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const chatSequence = calls
      .filter((call) => call.payload.channel === channelId)
      .map((call) => call.method)
      .filter((method) => method.startsWith("chat."));
    expect(chatSequence).toEqual([
      "chat.getPermalink",
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.getPermalink",
      "chat.update",
    ]);

    const started = calls.find(
      (call) => call.method === "chat.startStream" && call.payload.channel === channelId,
    )!;
    const outcomeChunks = calls
      .filter(
        (call) =>
          call.payload.channel === channelId &&
          (call.method === "chat.startStream" || call.method === "chat.appendStream"),
      )
      .map((call) => String(call.payload.markdown_text));
    const outcomeBody = outcomeChunks.join("");
    expect(outcomeChunks).toHaveLength(3);
    expect(outcomeBody).toBe(
      "✅ Implemented the Slack renderer and opened a focused pull request.\n",
    );
    expect(outcomeBody).not.toContain("*Done*");
    expect(outcomeBody).not.toContain(getTaskLink(ask.id));
    expect(started.payload.channel).toBe(channelId);
    expect(started.payload.thread_ts).toBe(threadTs);
    expect(started.payload.recipient_user_id).toBe("U_REQUESTER");
    expect(started.payload.recipient_team_id).toBe("T_TEST");
    expect(String(started.payload.markdown_text).startsWith("✅ Implemented")).toBe(true);
    expect(Object.keys(started.payload).sort()).toEqual([
      "channel",
      "markdown_text",
      "recipient_team_id",
      "recipient_user_id",
      "thread_ts",
    ]);
    for (const appended of calls.filter((call) => call.method === "chat.appendStream")) {
      expect(Object.keys(appended.payload).sort()).toEqual(["channel", "markdown_text", "ts"]);
    }
    const stopped = calls.find(
      (call) => call.method === "chat.stopStream" && call.payload.channel === channelId,
    )!;
    expect(Object.keys(stopped.payload).sort()).toEqual(["blocks", "channel", "ts"]);
    const completedAsk = getTaskById(ask.id)!;
    const duration = formatV2Duration(
      new Date(completedAsk.createdAt),
      new Date(completedAsk.finishedAt ?? completedAsk.lastUpdatedAt),
    );
    expect(stopped.payload.blocks).toEqual([
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${duration} · 1 worker · ${getTaskLink(ask.id)} · <${firstTree!.permalink}|↑ tree>`,
          },
        ],
      },
    ]);

    const treeUpdate = calls.find(
      (call) => call.method === "chat.update" && call.payload.channel === channelId,
    )!;
    expect(treeUpdate.payload.ts).toBe(firstTree?.ts);
    expect(treeUpdate.payload).toMatchObject({
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(treeUpdate.payload.text).toContain("→ <https://workspace.slack.com/");
    expect(treeUpdate.payload.text).not.toContain("PRIVATE RAW WORKER OUTPUT");
    expect(treeUpdate.payload.text).not.toContain("Tasks completed:");
    expect(
      calls.some((call) => call.method === "chat.update" && call.payload.ts === "outcome.1"),
    ).toBe(false);

    const outcome = getSlackOutcomeMessage(ask.id);
    expect(outcome?.kind).toBe("outcome");
    expect(outcome?.finalizedAt).toBeDefined();
    expect(outcome?.permalink).toContain("outcome1");
  });

  test("streams a bounded failed outcome with its reason", async () => {
    const lead = createAgent({ name: "Failure Lead", isLead: true, status: "idle" });
    const channelId = "C_RENDER_FAILURE";
    const threadTs = "400.1";
    const ask = createTaskExtended("failing ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    await Bun.sleep(2);
    const reason = `expected test failure ${"detail ".repeat(200)}`;
    failTask(ask.id, reason);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toContain("❌ *Failed*");
    const outcome = getSlackOutcomeMessage(ask.id);
    const remote = remoteMessages.get(remoteKey(channelId, outcome!.ts));
    expect(remote?.text.startsWith("❌ *Failed* expected test failure")).toBe(true);
    expect(remote?.text.endsWith("\n")).toBe(true);
    expect(remote?.text).not.toContain(getTaskLink(ask.id));
    expect(remote!.text.length).toBeLessThan(800);
    const update = calls.find(
      (call) => call.method === "chat.update" && call.payload.ts === tree?.ts,
    );
    expect(update?.payload.ts).toBe(tree?.ts);
    expect(update?.payload.text).toContain("↳ ❌ failing ask");
    expect(update?.payload.text).toContain("→ <https://workspace.slack.com/");
  });

  test("renders cancellation distinctly and carries the bounded reason", async () => {
    const lead = createAgent({ name: "Cancellation Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_CANCELLED");
    const ask = createTaskExtended("cancelled ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    cancelTask(ask.id, `requester changed direction ${"context ".repeat(200)}`);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toContain("🚫 *Cancelled*");
    const outcome = getSlackOutcomeMessage(ask.id)!;
    const remote = remoteMessages.get(remoteKey(channelId, outcome.ts));
    expect(remote?.text.startsWith("🚫 *Cancelled* requester changed direction")).toBe(true);
    expect(remote?.text.endsWith("\n")).toBe(true);
    expect(remote?.text).not.toContain(getTaskLink(ask.id));
    expect(remote!.text.length).toBeLessThan(800);
    const update = calls.find(
      (call) => call.method === "chat.update" && call.payload.ts === tree?.ts,
    );
    expect(update?.payload.text).toContain("↳ 🚫 cancelled ask");
  });

  test("serializes concurrent tree writers and leaves the newest outcome link visible", async () => {
    const lead = createAgent({ name: "Concurrent Writer Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_WRITER_RACE");
    const ask = createTaskExtended("serialize tree writers", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    _resetSlackRenderV2ForTests();
    calls.length = 0;
    nextUpdateBarrier = { started: deferred(), released: deferred() };
    const barrier = nextUpdateBarrier;

    await ensureSlackThreadTree([ask.id]);
    await barrier.started.promise;
    completeTask(ask.id, "The serialized writer must retain this result link.");
    const processing = processSlackRenderV2();
    await waitFor(() => calls.some((call) => call.method === "chat.stopStream"));
    barrier.released.resolve();
    await processing;

    const remoteTree = remoteMessages.get(remoteKey(channelId, tree!.ts));
    expect(remoteTree?.text).toContain("→ <https://workspace.slack.com/");
    const updates = calls.filter((call) => call.method === "chat.update");
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)?.payload.text).toContain("→ <https://workspace.slack.com/");
  });

  test("replaces a deleted tree exactly once after message_not_found", async () => {
    const lead = createAgent({ name: "Deleted Tree Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_DELETED");
    const ask = createTaskExtended("replace deleted tree", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    const original = await ensureSlackThreadTree([ask.id]);
    _resetSlackRenderV2ForTests();
    completeTask(ask.id, "Create an outcome, then replace the deleted tree.");
    missingMessageTs = original!.ts;
    calls.length = 0;

    await processSlackRenderV2();

    const replacement = getSlackTreeMessageByThread(channelId, threadTs)!;
    expect(replacement.id).not.toBe(original?.id);
    expect(replacement.ts).not.toBe(original?.ts);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    const remoteTree = remoteMessages.get(remoteKey(channelId, replacement.ts));
    expect(remoteTree?.text).toContain("→ <https://workspace.slack.com/");
    const stopped = calls.find((call) => call.method === "chat.stopStream");
    expect(JSON.stringify(stopped?.payload.blocks)).toContain(replacement.permalink!);

    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
  });

  test("advances the tree watermark for an identical snapshot without a Slack update", async () => {
    const worker = createAgent({ name: "Watermark Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_WATERMARK_NOOP");
    const task = createTaskExtended("settle identical tree state", {
      agentId: worker.id,
      source: "mcp",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
      followUpConfig: { disabled: true },
    });
    startTask(task.id);
    failTask(task.id, "stable terminal snapshot");
    const tree = await ensureSlackThreadTree([task.id]);
    await Bun.sleep(2);
    getDb().run(`UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?`, [
      new Date().toISOString(),
      task.id,
    ]);
    calls.length = 0;

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.update")).toBe(false);
    expect(getSlackTreeMessageByThread(channelId, threadTs)?.updatedAt).not.toBe(tree?.updatedAt);
    expect(getSlackTreeMessages()).toHaveLength(0);
  });

  test("does not advance the tree watermark when Slack update fails", async () => {
    const worker = createAgent({ name: "Retry Watermark Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_WATERMARK_RETRY");
    const task = createTaskExtended("retry failed tree update", {
      agentId: worker.id,
      source: "mcp",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
      followUpConfig: { disabled: true },
    });
    startTask(task.id);
    const tree = await ensureSlackThreadTree([task.id]);
    _resetSlackRenderV2ForTests();
    failTask(task.id, "state that must be retried");
    updateFailuresRemaining = 1;
    calls.length = 0;

    await processSlackRenderV2();

    expect(getSlackTreeMessageByThread(channelId, threadTs)?.updatedAt).toBe(tree?.updatedAt);
    expect(calls.filter((call) => call.method === "chat.update")).toHaveLength(1);
    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.filter((call) => call.method === "chat.update")).toHaveLength(1);
    expect(getSlackTreeMessageByThread(channelId, threadTs)?.updatedAt).not.toBe(tree?.updatedAt);
  });

  test("resumes an unfinished outcome by physical thread across context keys", async () => {
    const lead = createAgent({ name: "Recovery Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_RECOVERY");
    const firstAsk = createTaskExtended("establish the physical thread tree", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:first:${channelId}`,
    });
    startTask(firstAsk.id);
    const tree = await ensureSlackThreadTree([firstAsk.id]);
    failTask(firstAsk.id, "test setup");
    _resetSlackRenderV2ForTests();
    await processSlackRenderV2();

    const ask = createTaskExtended("recover streamed outcome", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:later:${channelId}`,
    });
    startTask(ask.id);
    expect((await ensureSlackThreadTree([ask.id]))?.id).toBe(tree?.id);
    completeTask(ask.id, "Recovered the outcome stream after a temporary interruption.");
    calls.length = 0;
    _resetSlackRenderV2ForTests();
    appendCallsUntilFailure = 1;

    await processSlackRenderV2();

    const interrupted = getSlackOutcomeMessage(ask.id);
    expect(interrupted?.contextKey).not.toBe(tree?.contextKey);
    expect(interrupted?.channelId).toBe(tree?.channelId);
    expect(interrupted?.threadTs).toBe(tree?.threadTs);
    expect(interrupted?.finalizedAt).toBeUndefined();
    expect(interrupted?.streamChunksAppended).toBe(2);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);

    calls.length = 0;
    _resetSlackRenderV2ForTests();
    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    expect(calls.filter((call) => call.method === "chat.appendStream")).toHaveLength(1);
    expect(calls.some((call) => call.method === "chat.stopStream")).toBe(true);
    expect(getSlackOutcomeMessage(ask.id)?.finalizedAt).toBeDefined();
  });
});
