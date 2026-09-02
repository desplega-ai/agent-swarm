import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createLogEntry,
  createTaskExtended,
  ensureSlackDelegationActivation,
  ensureSlackRenderV2Activation,
  failTask,
  getDbClient,
  getLogsByEventType,
  getSlackOutcomeMessage,
  getSlackRenderV2ActivatedAt,
  getSlackTreeMessage,
  getSlackTreeMessageByThread,
  getSlackTreeMessages,
  getTaskById,
  initDb,
  isPendingSlackMessage,
  markTaskSlackReplySent,
  startTask,
  supersedeTask,
  upsertSwarmConfig,
} from "../be/db";
import { getTaskLink, MAX_SECTION_LENGTH } from "../slack/blocks";
import {
  _resetSlackRenderV2ForTests,
  callSlackWithRetry,
  childOutcomeContent,
  ensureSlackThreadTree,
  formatV2Duration,
  isSlackRenderV2Enabled,
  processSlackRenderV2,
  renderThreadTree,
  streamOutcomeCard,
} from "../slack/render-v2";
import { getAgentDisplayName, getAgentEmoji } from "../slack/responses";
import { slackContextKey } from "../tasks/context-key";
import type { AgentTask } from "../types";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-slack-render-v2.sqlite";
const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
let treeCounter = 0;
let outcomeCounter = 0;
let stopCallsUntilFailure: number | undefined;
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

function seedRemoteSlackMessage(channel: string, threadTs: string, ts: string, text: string): void {
  remoteMessages.set(remoteKey(channel, ts), { channel, threadTs, ts, text });
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

/**
 * Backdates `lastUpdatedAt` directly via SQL so a closure appears quiet (or
 * timed out) without a wall-clock sleep — `closureState` reads real time via
 * `new Date()`, so tests inject "elapsed time" by moving the stored
 * timestamp into the past instead.
 */
async function backdateLastUpdated(taskIds: string[], secondsAgo: number): Promise<void> {
  const ts = new Date(Date.now() - secondsAgo * 1_000).toISOString();
  for (const id of taskIds) {
    await getDbClient().run(`UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?`, [ts, id]);
  }
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
    if (String(payload.markdown_text ?? "").length > 12_000) {
      throw new Error("markdown_text exceeded Slack's streaming limit");
    }
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
  if (method === "chat.appendStream") {
    const message = remoteMessages.get(remoteKey(String(payload.channel), String(payload.ts)));
    if (!message) throw { data: { error: "message_not_found" } };
    message.text += String(payload.markdown_text ?? "");
    return { ok: true };
  }
  if (method === "chat.stopStream") {
    if (stopCallsUntilFailure !== undefined) {
      if (stopCallsUntilFailure === 0) {
        stopCallsUntilFailure = undefined;
        throw new Error("temporary stop failure");
      }
      stopCallsUntilFailure--;
    }
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
  getSlackApp: () => ({
    client: {
      apiCall: mockApiCall,
      reactions: {
        add: (payload: Record<string, unknown>) => mockApiCall("reactions.add", payload),
        remove: (payload: Record<string, unknown>) => mockApiCall("reactions.remove", payload),
      },
    },
  }),
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
  clearVolatileSecretsForTesting();
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await ensureSlackRenderV2Activation();
  calls.length = 0;
  remoteMessages.clear();
  treeCounter = 0;
  outcomeCounter = 0;
  mockApiCall.mockClear();
  stopCallsUntilFailure = undefined;
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
  test("settles the accepted-message reaction after streaming a terminal outcome", async () => {
    const lead = await createAgent({ name: "Reaction Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_REACTION");
    const triggerTs = `${slackAddressSequence}.2`;
    const ask = await createTaskExtended("terminal reaction ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, "Done");
    calls.length = 0;

    await processSlackRenderV2();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.filter((call) => call.method === "reactions.remove")).toHaveLength(4);
    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "white_check_mark", timestamp: triggerTs },
    });
  });

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
    const lead = await createAgent({ name: "Upgrade Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_UPGRADE_HISTORY");
    const ask = await createTaskExtended("historical ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await completeTask(ask.id, "This historical result must not be replayed.");
    await getDbClient().run(
      `UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?`,
      ["2025-01-01T00:00:00.000Z", "2025-01-01T00:01:00.000Z", ask.id],
    );
    await getDbClient().run(`DELETE FROM slack_render_v2_state`);
    calls.length = 0;

    await processSlackRenderV2();

    expect(await getSlackRenderV2ActivatedAt()).not.toBeNull();
    expect(await getDbClient().query(`SELECT * FROM slack_messages`)).toHaveLength(0);
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
      const lead = await createAgent({ name: "Restart Lead", isLead: true, status: "idle" });
      const { channelId, threadTs } = uniqueSlackAddress("C_RESTART_HISTORY");
      const ask = await createTaskExtended("old ask before restart", {
        agentId: lead.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        contextKey: slackContextKey({ channelId, threadTs }),
      });
      await startTask(ask.id);
      await getDbClient().run(
        `UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?`,
        ["2025-02-01T00:00:00.000Z", "2025-02-01T00:01:00.000Z", ask.id],
      );

      await processSlackRenderV2();
      const firstActivation = await getSlackRenderV2ActivatedAt();
      closeDb();
      initDb(TEST_DB_PATH);
      _resetSlackRenderV2ForTests();
      calls.length = 0;

      await processSlackRenderV2();

      expect(firstActivation).not.toBeNull();
      expect(await getSlackRenderV2ActivatedAt()).toBe(firstActivation);
      expect(calls).toHaveLength(0);
    } finally {
      closeDb();
      if (migrationTemplate) testGlobals.__testMigrationTemplate = migrationTemplate;
      await removeDbFiles();
    }
  });

  test("keeps an accidental old tree active only for post-activation asks", async () => {
    const lead = await createAgent({ name: "Existing Tree Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_EXISTING_TREE");
    const contextKey = slackContextKey({ channelId, threadTs });
    const oldAsk = await createTaskExtended("old ask with an accidental tree", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    await startTask(oldAsk.id);
    const tree = await ensureSlackThreadTree([oldAsk.id]);
    await completeTask(oldAsk.id, "Old outcome must remain suppressed.");
    await getDbClient().run(`UPDATE agent_tasks SET createdAt = ? WHERE id = ?`, [
      "2025-03-01T00:00:00.000Z",
      oldAsk.id,
    ]);
    await getDbClient().run(`UPDATE slack_render_v2_state SET activated_at = ? WHERE id = 1`, [
      "2026-01-01T00:00:00.000Z",
    ]);
    const newAsk = await createTaskExtended("new ask in the existing thread", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    await startTask(newAsk.id);
    await completeTask(newAsk.id, "Only this new outcome should be rendered.");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect((await getSlackTreeMessageByThread(channelId, threadTs))?.id).toBe(tree?.id);
    expect(await getSlackOutcomeMessage(oldAsk.id)).toBeNull();
    expect((await getSlackOutcomeMessage(newAsk.id))?.finalizedAt).toBeDefined();
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
  });

  test("does not verify an old missing outcome when new active work awakens its tree", async () => {
    const lead = await createAgent({
      name: "Active Existing Tree Lead",
      isLead: true,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_ACTIVE_EXISTING_TREE");
    const contextKey = slackContextKey({ channelId, threadTs });
    const oldAsk = await createTaskExtended("old terminal ask without an outcome", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    await startTask(oldAsk.id);
    const tree = await ensureSlackThreadTree([oldAsk.id]);
    await completeTask(oldAsk.id, "This old outcome must not trigger tree verification.");
    await getDbClient().run(`UPDATE agent_tasks SET createdAt = ? WHERE id = ?`, [
      "2025-04-01T00:00:00.000Z",
      oldAsk.id,
    ]);
    await getDbClient().run(`UPDATE slack_render_v2_state SET activated_at = ? WHERE id = 1`, [
      "2026-01-01T00:00:00.000Z",
    ]);
    const activeAsk = await createTaskExtended("new active ask in the old thread", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    await startTask(activeAsk.id);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.getPermalink")).toBe(false);
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    expect((await getSlackTreeMessageByThread(channelId, threadTs))?.id).toBe(tree?.id);
    expect(await getSlackOutcomeMessage(oldAsk.id)).toBeNull();
  });

  test("stops an in-flight discovery pass after v2 is disabled", async () => {
    const lead = await createAgent({ name: "Kill Switch Lead", isLead: true, status: "idle" });
    for (const label of ["first", "second"]) {
      const { channelId, threadTs } = uniqueSlackAddress(`C_KILL_${label}`);
      const ask = await createTaskExtended(`${label} ask`, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        contextKey: slackContextKey({ channelId, threadTs }),
      });
      await startTask(ask.id);
    }
    disableRenderAfterMethod = "chat.postMessage";

    try {
      await processSlackRenderV2();
      expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
      expect(
        await getDbClient().query(`SELECT * FROM slack_messages WHERE kind = 'tree'`),
      ).toHaveLength(1);
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
    const lead = await createAgent({ name: "Permalink Lead", isLead: true, status: "idle" });
    const channelId = "C_TREE_PERMALINK";
    const threadTs = "150.1";
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = await createTaskExtended("permalink recovery", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    permalinkFailuresRemaining = 1;

    await expect(ensureSlackThreadTree([ask.id])).rejects.toThrow("temporary permalink failure");
    const persisted = await getSlackTreeMessage(contextKey);
    expect(persisted?.ts).toBeDefined();
    expect(persisted?.permalink).toBeUndefined();
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(calls.find((call) => call.method === "chat.postMessage")?.payload).toMatchObject({
      unfurl_links: false,
      unfurl_media: false,
      username: getAgentDisplayName(lead),
      icon_emoji: getAgentEmoji(lead),
    });

    calls.length = 0;
    const recovered = await ensureSlackThreadTree([ask.id]);
    expect(recovered?.ts).toBe(persisted?.ts);
    expect(recovered?.permalink).toContain("workspace.slack.com");
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    _resetSlackRenderV2ForTests();
  });

  test("reconciles a tree accepted before its timestamp bind without reposting", async () => {
    const lead = await createAgent({ name: "Tree Crash Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_BIND_CRASH");
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = await createTaskExtended("survive tree bind crash", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    await startTask(ask.id);
    await getDbClient().run(`CREATE TRIGGER fail_tree_timestamp_bind
      BEFORE UPDATE OF ts ON slack_messages
      WHEN OLD.kind = 'tree' AND OLD.ts LIKE 'pending:%'
      BEGIN SELECT RAISE(ABORT, 'simulated tree bind crash'); END`);

    await expect(ensureSlackThreadTree([ask.id])).rejects.toThrow("simulated tree bind crash");
    const pending = (await getSlackTreeMessage(contextKey))!;
    expect(isPendingSlackMessage(pending)).toBe(true);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(
      [...remoteMessages.values()].filter((message) => message.channel === channelId),
    ).toHaveLength(1);

    await getDbClient().run("DROP TRIGGER fail_tree_timestamp_bind");
    await completeTask(ask.id, "The tree state changed while its timestamp was not bound.");
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
    const lead = await createAgent({ name: "Thread Identity Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_THREAD_IDENTITY");
    const first = await createTaskExtended("first context", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:first:${channelId}`,
    });
    const second = await createTaskExtended("second context", {
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
    await failTask(first.id, "test cleanup");
    await failTask(second.id, "test cleanup");
  });

  test("formats compact elapsed time without spaces", () => {
    const start = new Date("2026-07-31T20:00:00.000Z");
    expect(formatV2Duration(start, new Date("2026-07-31T20:07:51.000Z"))).toBe("7m51s");
    expect(formatV2Duration(start, new Date("2026-07-31T20:16:01.000Z"))).toBe("16m01s");
    expect(formatV2Duration(start, new Date("2026-07-31T20:12:00.000Z"))).toBe("12m");
  });

  test("renders the frozen context tree without permalink backlinks", async () => {
    const lead = await createAgent({ name: "Lead", isLead: true, status: "idle" });
    const researcher = await createAgent({ name: "Researcher", isLead: false, status: "idle" });
    const contextKey = slackContextKey({ channelId: "C_TREE_SHAPE", threadTs: "100.1" });
    const ask = await createTaskExtended("format tests", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_TREE_SHAPE",
      slackThreadTs: "100.1",
      slackTriggerMessageTs: "100.2",
      contextKey,
    });
    const child = await createTaskExtended("research exact Slack API behavior", {
      agentId: researcher.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const grandchild = await createTaskExtended("verify payload", {
      agentId: researcher.id,
      source: "mcp",
      parentTaskId: child.id,
      followUpConfig: { disabled: true },
    });
    const secondAsk = await createTaskExtended("this PR", {
      agentId: lead.id,
      source: "slack",
      parentTaskId: grandchild.id,
      slackChannelId: "C_TREE_SHAPE",
      slackThreadTs: "100.1",
      slackTriggerMessageTs: "100.3",
      contextKey,
    });
    expect((await getTaskById(ask.id))?.slackTriggerMessageTs).toBe("100.2");
    expect((await getTaskById(child.id))?.slackTriggerMessageTs).toBeUndefined();
    expect((await getTaskById(grandchild.id))?.slackTriggerMessageTs).toBeUndefined();
    const fixedStart = new Date("2026-07-31T20:00:00.000Z").toISOString();
    const now = new Date("2026-07-31T20:08:05.000Z");
    const finishedAt = new Date("2026-07-31T20:04:00.000Z").toISOString();
    const outcomeUrl = "https://workspace.slack.com/archives/C_TREE_SHAPE/p1004";
    const triggerLinks = new Map([
      [ask.id, "https://workspace.slack.com/archives/C_TREE_SHAPE/p1002"],
      [secondAsk.id, "https://workspace.slack.com/archives/C_TREE_SHAPE/p1003"],
    ]);
    const text = await renderThreadTree(
      [
        { ...ask, createdAt: fixedStart },
        { ...child, createdAt: fixedStart, progress: "Reading **Slack docs** carefully" },
        {
          ...grandchild,
          createdAt: fixedStart,
          status: "completed" as const,
          finishedAt,
        },
        {
          ...secondAsk,
          task: "<thread_context>\nold context\n</thread_context>\n\n[Thread follow-up — 1 message(s) buffered]\n\nship this PR",
          createdAt: fixedStart,
        },
      ],
      new Map([[grandchild.id, outcomeUrl]]),
      now,
      triggerLinks,
    );

    expect(text).toBe(
      [
        "🧵 🔄 working — 8m05s",
        ` ↳ ▶️ format tests · 8m05s · <https://app.agent-swarm.dev/tasks/${ask.id}|\`${ask.id.slice(0, 8)}\`>`,
        `    ↳ ▶️ Researcher · 8m05s · <https://app.agent-swarm.dev/tasks/${child.id}|\`${child.id.slice(0, 8)}\`> · Reading *Slack docs* carefully…`,
        `       ↳ ✅ Researcher · 4m · <https://app.agent-swarm.dev/tasks/${grandchild.id}|\`${grandchild.id.slice(0, 8)}\`>`,
        ` ↳ ▶️ ship this PR · 8m05s · <https://app.agent-swarm.dev/tasks/${secondAsk.id}|\`${secondAsk.id.slice(0, 8)}\`>`,
      ].join("\n"),
    );
    expect(text).not.toContain("workspace.slack.com");
    expect(text).not.toContain("|↵>");
    expect(text).not.toContain("|result>");
    expect(text).toContain(getTaskLink(ask.id));
    expect(text).toContain(`\`${ask.id.slice(0, 8)}\``);
    expect(text).not.toContain("```");
    expect(text).not.toContain("↩");
    expect(text).not.toContain(":leftwards_arrow_with_hook:");
    const rows = text.split("\n").slice(1);
    expect(rows.slice(0, 3).map((row) => row.match(/^ +/u)?.[0].length)).toEqual([1, 4, 7]);
  });

  test("glyphs: running vs stalled in_progress, and a pending task blocked on a dependency", async () => {
    const lead = await createAgent({ name: "Glyph Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Glyph Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("glyph ask", { agentId: lead.id, source: "slack" });
    const freshRunning = await createTaskExtended("fresh running child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const stalledRunning = await createTaskExtended("stalled running child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const blocker = await createTaskExtended("blocker", { agentId: worker.id, source: "mcp" });
    const blockedChild = await createTaskExtended("blocked child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      dependsOn: [blocker.id],
      followUpConfig: { disabled: true },
    });

    const now = new Date();
    const sixteenMinAgo = new Date(now.getTime() - 16 * 60_000).toISOString();

    const text = await renderThreadTree(
      [
        { ...ask, status: "pending" as const },
        { ...freshRunning, status: "in_progress" as const, lastUpdatedAt: now.toISOString() },
        { ...stalledRunning, status: "in_progress" as const, lastUpdatedAt: sixteenMinAgo },
        { ...blockedChild, status: "pending" as const },
      ],
      new Map(),
      now,
    );

    const lines = text.split("\n");
    const freshLine = lines.find((line) => line.includes(getTaskLink(freshRunning.id)));
    const stalledLine = lines.find((line) => line.includes(getTaskLink(stalledRunning.id)));
    const blockedLine = lines.find((line) => line.includes(getTaskLink(blockedChild.id)));
    expect(freshLine).toContain("🔄");
    expect(stalledLine).toContain("⚠️");
    expect(blockedLine).toContain("⛔");
  });

  test("header transitions from active to stalled to done", async () => {
    const lead = await createAgent({ name: "Header Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Header Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("header ask", { agentId: lead.id, source: "slack" });
    const child = await createTaskExtended("header child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const now = new Date();

    const activeText = await renderThreadTree(
      [
        { ...ask, status: "in_progress" as const, lastUpdatedAt: now.toISOString() },
        { ...child, status: "in_progress" as const, lastUpdatedAt: now.toISOString() },
      ],
      new Map(),
      now,
    );
    expect(activeText.startsWith("🧵 🔄 working")).toBe(true);

    const sixteenMinAgo = new Date(now.getTime() - 16 * 60_000).toISOString();
    const stalledText = await renderThreadTree(
      [
        { ...ask, status: "in_progress" as const, lastUpdatedAt: now.toISOString() },
        { ...child, status: "in_progress" as const, lastUpdatedAt: sixteenMinAgo },
      ],
      new Map(),
      now,
    );
    expect(stalledText.startsWith("🧵 ⚠️ stalled")).toBe(true);

    const doneText = await renderThreadTree(
      [
        {
          ...ask,
          status: "completed" as const,
          lastUpdatedAt: now.toISOString(),
          finishedAt: now.toISOString(),
        },
        {
          ...child,
          status: "completed" as const,
          lastUpdatedAt: now.toISOString(),
          finishedAt: now.toISOString(),
        },
      ],
      new Map(),
      now,
    );
    expect(doneText.startsWith("🧵 ✅ done")).toBe(true);
  });

  test("does not resolve or render direct-trigger permalink backlinks", async () => {
    const lead = await createAgent({ name: "Trigger Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Trigger Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TRIGGER_LINKS");
    const contextKey = slackContextKey({ channelId, threadTs });
    const firstTs = `${slackAddressSequence}.2`;
    const secondTs = `${slackAddressSequence}.3`;
    seedRemoteSlackMessage(channelId, threadTs, firstTs, "first human ask");
    seedRemoteSlackMessage(channelId, threadTs, secondTs, "second human ask");
    const first = await createTaskExtended("first human ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: firstTs,
      contextKey,
    });
    const child = await createTaskExtended("delegated work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: first.id,
      followUpConfig: { disabled: true },
    });
    const second = await createTaskExtended("second human ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: secondTs,
      contextKey,
    });

    await ensureSlackThreadTree([first.id, child.id, second.id]);

    const posted = calls.find((call) => call.method === "chat.postMessage")!;
    expect(posted.payload.text).not.toContain(`p${firstTs.replaceAll(".", "")}|↵>`);
    expect(posted.payload.text).not.toContain(`p${secondTs.replaceAll(".", "")}|↵>`);
    expect(String(posted.payload.text)).not.toContain("|↵>");
    expect(String(posted.payload.text)).not.toContain("↩");
    expect(String(posted.payload.text)).not.toContain(":leftwards_arrow_with_hook:");
    expect(calls.filter((call) => call.method === "chat.getPermalink")).toHaveLength(1);
    const blocks = posted.payload.blocks as Array<{
      type: string;
      elements: Array<{ type: string; text: string }>;
    }>;
    expect(blocks.every((block) => block.type === "context")).toBe(true);
    expect(blocks.every((block) => block.elements[0]?.type === "mrkdwn")).toBe(true);
  });

  test("collapses older tasks before a persistent tree exceeds Slack's section limit", async () => {
    const lead = await createAgent({ name: "Overflow Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_OVERFLOW");
    const tasks: AgentTask[] = [];
    for (let index = 0; index < 80; index++) {
      tasks.push(
        await createTaskExtended(`overflow task ${index} ${"x".repeat(60)}`, {
          agentId: lead.id,
          source: "slack",
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          contextKey: slackContextKey({ channelId, threadTs }),
        }),
      );
    }

    await ensureSlackThreadTree([tasks.at(-1)!.id]);

    const posted = calls.find(
      (call) => call.method === "chat.postMessage" && call.payload.channel === channelId,
    )!;
    const text = posted.payload.text as string;
    const blocks = posted.payload.blocks as Array<{ elements: Array<{ text: string }> }>;
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_LENGTH);
    expect(blocks[0]?.elements[0]?.text).toBe(text);
    expect(text).toContain("older tasks collapsed");
    expect(text).toContain(tasks.at(-1)!.id.slice(0, 8));
    expect(text).not.toContain(tasks[1]!.id.slice(0, 8));
    expect(text.split("\n").filter((line) => line.startsWith(" ↳"))).not.toHaveLength(0);
    expect(text).not.toMatch(/[├└│]/);

    for (const task of tasks) await failTask(task.id, "test cleanup");
  });

  test("caps a pathological tree line and keeps the newest task in valid sections", async () => {
    const lead = await createAgent({ name: "Pathological Lead", isLead: true, status: "idle" });
    const worker = await createAgent({
      name: `Worker ${"x".repeat(5_000)}`,
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_LONG_LINE");
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = await createTaskExtended("pathological tree line", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey,
    });
    const child = await createTaskExtended("render the long worker label", {
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
    const blocks = posted.payload.blocks as Array<{ elements: Array<{ text: string }> }>;
    expect(blocks.every((block) => block.elements[0]!.text.length <= MAX_SECTION_LENGTH)).toBe(
      true,
    );
    expect(blocks.map((block) => block.elements[0]!.text).join("\n")).toContain(
      child.id.slice(0, 8),
    );
  });

  test("discovers an ask that completed before the first poll and emits one tree and card", async () => {
    const lead = await createAgent({ name: "Fast Terminal Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_FAST_TERMINAL");
    const ask = await createTaskExtended("finish before renderer poll", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await completeTask(ask.id, "Finished before the renderer observed the in-progress state.");

    await processSlackRenderV2();

    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
    expect(calls.some((call) => call.method === "conversations.replies")).toBe(false);
    expect(await getSlackTreeMessageByThread(channelId, threadTs)).not.toBeNull();
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
  });

  test("reconciles a started outcome before its timestamp bind without a duplicate stream", async () => {
    const lead = await createAgent({ name: "Outcome Crash Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_OUTCOME_BIND_CRASH");
    const ask = await createTaskExtended("survive outcome bind crash", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, "Recover this outcome through its deterministic task link.");
    await getDbClient().run(`CREATE TRIGGER fail_outcome_timestamp_bind
      BEFORE UPDATE OF ts ON slack_messages
      WHEN OLD.kind = 'outcome' AND OLD.ts LIKE 'pending:%'
      BEGIN SELECT RAISE(ABORT, 'simulated outcome bind crash'); END`);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const pending = (await getSlackOutcomeMessage(ask.id))!;
    expect(isPendingSlackMessage(pending)).toBe(true);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
    const firstChunk = calls.find((call) => call.method === "chat.startStream")?.payload
      .markdown_text;
    expect(typeof firstChunk).toBe("string");
    expect(remoteMessages.get(remoteKey(channelId, `outcome.${outcomeCounter}`))?.text).toBe(
      firstChunk,
    );
    await getDbClient().run("DROP TRIGGER fail_outcome_timestamp_bind");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    expect(calls.some((call) => call.method === "conversations.replies")).toBe(true);
    expect((await getSlackOutcomeMessage(ask.id))?.id).toBe(pending.id);
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
    expect(
      [...remoteMessages.values()].filter(
        (message) => message.channel === channelId && message.ts.startsWith("outcome."),
      ),
    ).toHaveLength(1);
  });

  test("reuses one persisted tree and streams one immutable outcome before linking it", async () => {
    const lead = await createAgent({ name: "Lead v2", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Researcher v2", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_V2");
    const contextKey = slackContextKey({ channelId, threadTs });
    const ask = await createTaskExtended("ship Slack renderer", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_REQUESTER",
      contextKey,
    });
    const child = await createTaskExtended("research implementation", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(ask.id);
    await startTask(child.id);

    const firstTree = await ensureSlackThreadTree([ask.id, child.id]);
    expect(firstTree?.kind).toBe("tree");
    expect((await getSlackTreeMessage(contextKey))?.ts).toBe(firstTree?.ts);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);

    const secondAsk = await createTaskExtended("follow-up ask", {
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

    await completeTask(child.id, "PRIVATE RAW WORKER OUTPUT THAT MUST NOT REACH SLACK");
    await completeTask(
      ask.id,
      "Implemented the Slack renderer and opened a focused pull request.\n\n\n\nSecond paragraph that must be rendered.   ",
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
      "chat.stopStream",
      "chat.getPermalink",
      "chat.update",
    ]);

    const started = calls.find(
      (call) => call.method === "chat.startStream" && call.payload.channel === channelId,
    )!;
    const outcomeChunks = calls
      .filter((call) => call.payload.channel === channelId && call.method === "chat.startStream")
      .map((call) => String(call.payload.markdown_text));
    const outcomeBody = outcomeChunks.join("");
    expect(outcomeChunks).toHaveLength(1);
    expect(outcomeBody).toBe(
      "✅\n\nImplemented the Slack renderer and opened a focused pull request.\n\nSecond paragraph that must be rendered.",
    );
    expect(outcomeBody).not.toMatch(/\n{3,}/);
    expect(outcomeBody).toBe(outcomeBody.trim());
    expect(outcomeBody).not.toContain("**Done**");
    expect(outcomeBody).not.toContain(getTaskLink(ask.id));
    expect(started.payload.channel).toBe(channelId);
    expect(started.payload.thread_ts).toBe(threadTs);
    expect(started.payload.recipient_user_id).toBe("U_REQUESTER");
    expect(started.payload.recipient_team_id).toBe("T_TEST");
    expect(String(started.payload.markdown_text).startsWith("✅\n\nImplemented")).toBe(true);
    expect(Object.keys(started.payload).sort()).toEqual([
      "channel",
      "icon_emoji",
      "markdown_text",
      "recipient_team_id",
      "recipient_user_id",
      "thread_ts",
      "username",
    ]);
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);
    const stopped = calls.find(
      (call) => call.method === "chat.stopStream" && call.payload.channel === channelId,
    )!;
    expect(Object.keys(stopped.payload).sort()).toEqual(["blocks", "channel", "ts"]);
    const completedAsk = (await getTaskById(ask.id))!;
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
            text: `${duration} · 1 worker · ${getTaskLink(ask.id)}`,
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
    expect(treeUpdate.payload.text).not.toContain("workspace.slack.com");
    expect(treeUpdate.payload.text).not.toContain("|result>");
    expect(treeUpdate.payload.text).not.toContain("PRIVATE RAW WORKER OUTPUT");
    expect(treeUpdate.payload.text).not.toContain("Tasks completed:");
    expect(
      calls.some((call) => call.method === "chat.update" && call.payload.ts === "outcome.1"),
    ).toBe(false);

    const outcome = await getSlackOutcomeMessage(ask.id);
    expect(outcome?.kind).toBe("outcome");
    expect(outcome?.finalizedAt).toBeDefined();
    expect(outcome?.permalink).toContain("outcome1");
  });

  test("preserves complete native Markdown beyond the Block Kit text ceiling", async () => {
    const lead = await createAgent({ name: "Markdown Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_OUTCOME_MARKDOWN");
    const ask = await createTaskExtended("preserve native Markdown", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    const output = [
      "# Complete result",
      "",
      "**Bold text** and [a labeled link](https://example.com/result).",
      "",
      "- first item",
      "  - nested item",
      "",
      "```ts",
      'const message = "preserved";',
      "```",
      "",
      `Long section: ${"native markdown remains intact. ".repeat(150)}`,
    ].join("\n");
    expect(output.length).toBeGreaterThan(3_000);
    expect(output.length).toBeLessThan(12_000);
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, output);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toBe(`✅\n\n${output.trim()}`);
    expect(String(started?.payload.markdown_text)).toContain("# Complete result");
    expect(String(started?.payload.markdown_text)).toContain("**Bold text**");
    expect(String(started?.payload.markdown_text)).toContain(
      "[a labeled link](https://example.com/result)",
    );
    expect(String(started?.payload.markdown_text)).toContain("  - nested item");
    expect(String(started?.payload.markdown_text)).toContain(
      '```ts\nconst message = "preserved";\n```',
    );
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);
  });

  test("truncates oversized Markdown before a code fence and links the full task", async () => {
    const lead = await createAgent({ name: "Overflow Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_OUTCOME_OVERFLOW");
    const ask = await createTaskExtended("truncate oversized Markdown safely", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    const safeParagraphs = Array.from(
      { length: 60 },
      (_, index) =>
        `Safe paragraph ${index}: every complete sentence stays intact at a line boundary before overflow.`,
    ).join("\n\n");
    const oversizedFence = `\`\`\`ts\n${"const omitted = true;\n".repeat(500)}\`\`\``;
    const output = [
      "# Full result",
      "",
      "```ts",
      "const included = true;",
      "```",
      "",
      safeParagraphs,
      "",
      oversizedFence,
    ].join("\n");
    expect(output.length).toBeGreaterThan(12_000);
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, output);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    const markdown = String(started?.payload.markdown_text);
    const suffix = `… [View full task output](https://app.agent-swarm.dev/tasks/${ask.id})`;
    expect(markdown.length).toBeLessThanOrEqual(12_000);
    expect(markdown).toEndWith(suffix);
    expect(markdown).toContain("Safe paragraph 59:");
    expect(markdown).not.toContain("const omitted = true;");
    expect(markdown.match(/^```/gm)).toHaveLength(2);
    expect(markdown.slice(0, -suffix.length).trimEnd()).toEndWith("before overflow.");
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
  });

  test("streams the complete failed outcome with its reason", async () => {
    const lead = await createAgent({ name: "Failure Lead", isLead: true, status: "idle" });
    const channelId = "C_RENDER_FAILURE";
    const threadTs = "400.1";
    const ask = await createTaskExtended("failing ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    await Bun.sleep(2);
    const reason = `expected test failure ${"detail ".repeat(200)}`;
    await failTask(ask.id, reason);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toContain("❌ **Failed**");
    const outcome = await getSlackOutcomeMessage(ask.id);
    const remote = remoteMessages.get(remoteKey(channelId, outcome!.ts));
    expect(remote?.text).toBe(`❌ **Failed**\n\n${reason.trim()}`);
    expect(remote?.text).not.toContain(getTaskLink(ask.id));
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);
    const update = calls.find(
      (call) => call.method === "chat.update" && call.payload.ts === tree?.ts,
    );
    expect(update?.payload.ts).toBe(tree?.ts);
    expect(update?.payload.text).toContain("↳ ❌ failing ask");
    expect(update?.payload.text).not.toContain("workspace.slack.com");
  });

  test("renders cancellation distinctly and carries the complete reason", async () => {
    const lead = await createAgent({ name: "Cancellation Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_CANCELLED");
    const ask = await createTaskExtended("cancelled ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    await cancelTask(ask.id, `requester changed direction ${"context ".repeat(200)}`);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toContain("🚫 **Cancelled**");
    const outcome = (await getSlackOutcomeMessage(ask.id))!;
    const remote = remoteMessages.get(remoteKey(channelId, outcome.ts));
    expect(remote?.text).toBe(
      `🚫 **Cancelled**\n\nrequester changed direction ${"context ".repeat(200)}`.trim(),
    );
    expect(remote?.text).not.toContain(getTaskLink(ask.id));
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);
    const update = calls.find(
      (call) => call.method === "chat.update" && call.payload.ts === tree?.ts,
    );
    expect(update?.payload.text).toContain("↳ 🚫 cancelled ask");
  });

  test("serializes concurrent tree writers and leaves the newest terminal state visible", async () => {
    const lead = await createAgent({
      name: "Concurrent Writer Lead",
      isLead: true,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_WRITER_RACE");
    const ask = await createTaskExtended("serialize tree writers", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    _resetSlackRenderV2ForTests();
    calls.length = 0;
    nextUpdateBarrier = { started: deferred(), released: deferred() };
    const barrier = nextUpdateBarrier;

    await ensureSlackThreadTree([ask.id]);
    await barrier.started.promise;
    await completeTask(ask.id, "The serialized writer must retain this result link.");
    const processing = processSlackRenderV2();
    await waitFor(() => calls.some((call) => call.method === "chat.stopStream"));
    barrier.released.resolve();
    await processing;

    const remoteTree = remoteMessages.get(remoteKey(channelId, tree!.ts));
    expect(remoteTree?.text).toContain(`↳ ✅ serialize tree writers`);
    expect(remoteTree?.text).not.toContain("workspace.slack.com");
    const updates = calls.filter((call) => call.method === "chat.update");
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)?.payload.text).toContain(`↳ ✅ serialize tree writers`);
    expect(updates.at(-1)?.payload.text).not.toContain("workspace.slack.com");
  });

  test("replaces a deleted tree exactly once after message_not_found", async () => {
    const lead = await createAgent({ name: "Deleted Tree Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_DELETED");
    const ask = await createTaskExtended("replace deleted tree", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const original = await ensureSlackThreadTree([ask.id]);
    _resetSlackRenderV2ForTests();
    await completeTask(ask.id, "Create an outcome, then replace the deleted tree.");
    missingMessageTs = original!.ts;
    calls.length = 0;

    await processSlackRenderV2();

    const replacement = (await getSlackTreeMessageByThread(channelId, threadTs))!;
    expect(replacement.id).not.toBe(original?.id);
    expect(replacement.ts).not.toBe(original?.ts);
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
    const remoteTree = remoteMessages.get(remoteKey(channelId, replacement.ts));
    expect(remoteTree?.text).toContain(`↳ ✅ replace deleted tree`);
    expect(remoteTree?.text).not.toContain("workspace.slack.com");
    const stopped = calls.find((call) => call.method === "chat.stopStream");
    expect(JSON.stringify(stopped?.payload.blocks)).not.toContain(replacement.permalink!);
    expect(JSON.stringify(stopped?.payload.blocks)).toContain(getTaskLink(ask.id));

    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
  });

  test("advances the tree watermark for an identical snapshot without a Slack update", async () => {
    const worker = await createAgent({ name: "Watermark Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_WATERMARK_NOOP");
    const task = await createTaskExtended("settle identical tree state", {
      agentId: worker.id,
      source: "mcp",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
      followUpConfig: { disabled: true },
    });
    await startTask(task.id);
    await failTask(task.id, "stable terminal snapshot");
    const tree = await ensureSlackThreadTree([task.id]);
    await Bun.sleep(2);
    await getDbClient().run(`UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?`, [
      new Date().toISOString(),
      task.id,
    ]);
    calls.length = 0;

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.update")).toBe(false);
    expect((await getSlackTreeMessageByThread(channelId, threadTs))?.updatedAt).not.toBe(
      tree?.updatedAt,
    );
    expect(await getSlackTreeMessages()).toHaveLength(0);
  });

  test("does not advance the tree watermark when Slack update fails", async () => {
    const worker = await createAgent({
      name: "Retry Watermark Worker",
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_TREE_WATERMARK_RETRY");
    const task = await createTaskExtended("retry failed tree update", {
      agentId: worker.id,
      source: "mcp",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
      followUpConfig: { disabled: true },
    });
    await startTask(task.id);
    const tree = await ensureSlackThreadTree([task.id]);
    _resetSlackRenderV2ForTests();
    // The stale-tree query compares `task.lastUpdatedAt > tree.updated_at` at
    // millisecond resolution; failing the task in the same millisecond the tree
    // was rendered makes the renderer see nothing to do (flaked ~1 in 3 runs).
    await Bun.sleep(2);
    await failTask(task.id, "state that must be retried");
    updateFailuresRemaining = 1;
    calls.length = 0;

    await processSlackRenderV2();

    expect((await getSlackTreeMessageByThread(channelId, threadTs))?.updatedAt).toBe(
      tree?.updatedAt,
    );
    expect(calls.filter((call) => call.method === "chat.update")).toHaveLength(1);
    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.filter((call) => call.method === "chat.update")).toHaveLength(1);
    expect((await getSlackTreeMessageByThread(channelId, threadTs))?.updatedAt).not.toBe(
      tree?.updatedAt,
    );
  });

  test("resumes an unfinished outcome by physical thread across context keys", async () => {
    const lead = await createAgent({ name: "Recovery Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_RECOVERY");
    const firstAsk = await createTaskExtended("establish the physical thread tree", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:first:${channelId}`,
    });
    await startTask(firstAsk.id);
    const tree = await ensureSlackThreadTree([firstAsk.id]);
    await failTask(firstAsk.id, "test setup");
    _resetSlackRenderV2ForTests();
    await processSlackRenderV2();

    const ask = await createTaskExtended("recover streamed outcome", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: `custom:later:${channelId}`,
    });
    await startTask(ask.id);
    expect((await ensureSlackThreadTree([ask.id]))?.id).toBe(tree?.id);
    await completeTask(ask.id, "Recovered the outcome stream after a temporary interruption.");
    calls.length = 0;
    _resetSlackRenderV2ForTests();
    stopCallsUntilFailure = 0;

    await processSlackRenderV2();

    const interrupted = await getSlackOutcomeMessage(ask.id);
    expect(interrupted?.contextKey).not.toBe(tree?.contextKey);
    expect(interrupted?.channelId).toBe(tree?.channelId);
    expect(interrupted?.threadTs).toBe(tree?.threadTs);
    expect(interrupted?.finalizedAt).toBeUndefined();
    expect(interrupted?.streamChunksAppended).toBe(1);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);

    calls.length = 0;
    _resetSlackRenderV2ForTests();
    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    expect(calls.some((call) => call.method === "chat.appendStream")).toBe(false);
    expect(calls.some((call) => call.method === "chat.stopStream")).toBe(true);
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
  });

  test("collapses the outcome card to a minimal form when the agent already replied", async () => {
    const lead = await createAgent({ name: "Reply Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_REPLY_SENT");
    const ask = await createTaskExtended("ask with an inline reply", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await markTaskSlackReplySent(ask.id);
    await completeTask(ask.id, "PRIVATE OUTPUT ALREADY POSTED VIA SLACK-REPLY, MUST NOT REPEAT");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toBe(`✅ ${lead.name} completed`);
    expect(started?.payload).toMatchObject({
      username: getAgentDisplayName(lead),
      icon_emoji: getAgentEmoji(lead),
    });
    expect(started?.payload.markdown_text).not.toContain("PRIVATE OUTPUT");
    const stopped = calls.find((call) => call.method === "chat.stopStream")!;
    const completedAsk = (await getTaskById(ask.id))!;
    const duration = formatV2Duration(
      new Date(completedAsk.createdAt),
      new Date(completedAsk.finishedAt ?? completedAsk.lastUpdatedAt),
    );
    expect(stopped.payload.blocks).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${duration} · ${lead.name} · ${getTaskLink(ask.id)}` }],
      },
    ]);
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
  });

  test("keeps the full outcome body when the agent has not replied inline", async () => {
    const lead = await createAgent({ name: "No Reply Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_NO_REPLY");
    const ask = await createTaskExtended("ask without an inline reply", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, "This output must reach Slack since no slack-reply was sent.");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toBe(
      "✅\n\nThis output must reach Slack since no slack-reply was sent.",
    );
  });

  test("redacts a runtime-rotated config secret from persisted output and its Slack outcome", async () => {
    const lead = await createAgent({ name: "Rotating Secret Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_ROTATED_SECRET");
    const ask = await createTaskExtended("rotate a secret before completing", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    const secret = `rotated-directory-token-${crypto.randomUUID()}`;
    const redacted = "[REDACTED:config:AUTOINFRA_DIRECTORY_ACCESS_VALUE]";

    await upsertSwarmConfig({
      scope: "global",
      key: "AUTOINFRA_DIRECTORY_ACCESS_VALUE",
      value: secret,
      isSecret: true,
    });
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, `Artifact: https://example.test/downloads/${secret}/result.json`);

    const persistedOutput = (await getTaskById(ask.id))?.output;
    expect(persistedOutput).toBe(
      `Artifact: https://example.test/downloads/${redacted}/result.json`,
    );
    expect(persistedOutput).not.toContain(secret);

    calls.length = 0;
    _resetSlackRenderV2ForTests();
    await processSlackRenderV2();

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toBe(
      `✅\n\nArtifact: https://example.test/downloads/${redacted}/result.json`,
    );
    expect(started?.payload.markdown_text).not.toContain(secret);
  });

  test("re-reads slackReplySent inside streamOutcomeCard to avoid a stale caller snapshot", async () => {
    const lead = await createAgent({ name: "Stale Snapshot Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_STALE_SNAPSHOT");
    const ask = await createTaskExtended("ask observed before its reply landed", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, "PRIVATE OUTPUT THAT MUST NOT LEAK IF THE REPLY LANDS LATER");
    // Simulate a stale snapshot: the caller fetched this task before slack-reply committed.
    const staleSnapshot = { ...(await getTaskById(ask.id))!, slackReplySent: false };
    await markTaskSlackReplySent(ask.id);
    calls.length = 0;

    const outcome = await streamOutcomeCard(staleSnapshot, tree!);

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toBe(`✅ ${lead.name} completed`);
    expect(started?.payload.markdown_text).not.toContain("PRIVATE OUTPUT");
    expect(outcome?.finalizedAt).toBeDefined();
  });

  test("refreshes a stream started with stale content before finalizing it", async () => {
    const lead = await createAgent({ name: "Refresh Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_REFRESH_STALE");
    const ask = await createTaskExtended("ask whose reply lands mid-stream", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    await completeTask(ask.id, "PRIVATE OUTPUT THAT MUST NOT SURVIVE A LATE SLACK-REPLY");
    calls.length = 0;
    _resetSlackRenderV2ForTests();
    // The stream starts with the full (pre-reply) output, then the process fails
    // before chat.stopStream — leaving an unfinalized stream with stale content.
    stopCallsUntilFailure = 0;

    await processSlackRenderV2();

    const interrupted = await getSlackOutcomeMessage(ask.id);
    expect(interrupted?.finalizedAt).toBeUndefined();
    const startedFirst = calls.find((call) => call.method === "chat.startStream");
    expect(startedFirst?.payload.markdown_text).toContain("PRIVATE OUTPUT");
    expect(remoteMessages.get(remoteKey(channelId, interrupted!.ts))?.text).toContain(
      "PRIVATE OUTPUT",
    );

    // The agent's slack-reply lands after the stream started but before the retry.
    await markTaskSlackReplySent(ask.id);
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    const refreshed = calls.find(
      (call) => call.method === "chat.update" && call.payload.ts === interrupted?.ts,
    );
    expect(refreshed?.payload.text).toBe(`✅ ${lead.name} completed`);
    expect(refreshed?.payload.text).not.toContain("PRIVATE OUTPUT");
    expect(remoteMessages.get(remoteKey(channelId, interrupted!.ts))?.text).not.toContain(
      "PRIVATE OUTPUT",
    );
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
  });
});

describe("Slack renderer v2 delegation (SLACK_RENDER_V2_DELEGATION)", () => {
  beforeEach(async () => {
    process.env.SLACK_RENDER_V2_DELEGATION = "true";
    // Pre-activate so every fixture task, created after this point, is a
    // post-activation task — matching how a real deployment (flag flipped
    // on, then work dispatched) behaves. The lazy activation call inside
    // processSlackRenderV2 is a no-op once this row already exists.
    await ensureSlackDelegationActivation();
  });

  afterEach(() => {
    delete process.env.SLACK_RENDER_V2_DELEGATION;
    delete process.env.SLACK_CONCLUSION_SETTLE_SEC;
    delete process.env.SLACK_CONCLUSION_TIMEOUT_MIN;
  });

  // --- T3: child result cards ---------------------------------------------

  test("an eligible mcp child posts once and never twice across 3 ticks", async () => {
    const lead = await createAgent({ name: "Delegation Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Delegation Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_CHILD_ONCE");
    const ask = await createTaskExtended("delegate research", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("research the API", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "Found the answer.");
    calls.length = 0;

    await processSlackRenderV2();
    await processSlackRenderV2();
    await processSlackRenderV2();

    const startStreamCalls = calls.filter((call) => call.method === "chat.startStream");
    expect(startStreamCalls).toHaveLength(1);
    expect(String(startStreamCalls[0]!.payload.markdown_text)).toContain(
      "↳ ✅ Delegation Worker — result",
    );
    expect((await getSlackOutcomeMessage(child.id))?.finalizedAt).toBeDefined();
  });

  test("follow-up and reroute-decision children never get a card; a resume child does", async () => {
    const lead = await createAgent({ name: "Tasktype Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Tasktype Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TASKTYPE");
    const ask = await createTaskExtended("tasktype ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);

    const followUp = await createTaskExtended("[Thread follow-up] wrap up", {
      agentId: lead.id,
      source: "system",
      taskType: "follow-up",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(followUp.id);
    await completeTask(followUp.id, "follow-up output");

    const reroute = await createTaskExtended("reroute decision", {
      agentId: lead.id,
      source: "system",
      taskType: "reroute-decision",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(reroute.id);
    await completeTask(reroute.id, "reroute output");

    const crashed = await createTaskExtended("crashed work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(crashed.id);
    const resume = await createTaskExtended("resume the crashed work", {
      agentId: worker.id,
      source: "system",
      taskType: "resume",
      parentTaskId: crashed.id,
      followUpConfig: { disabled: true },
    });
    await supersedeTask(crashed.id, { reason: "crash_recovery", resumeTaskId: resume.id });
    await startTask(resume.id);
    await completeTask(resume.id, "resume result");
    calls.length = 0;

    await processSlackRenderV2();
    await processSlackRenderV2();
    await processSlackRenderV2();

    expect(await getSlackOutcomeMessage(followUp.id)).toBeNull();
    expect(await getSlackOutcomeMessage(reroute.id)).toBeNull();
    expect((await getSlackOutcomeMessage(resume.id))?.finalizedAt).toBeDefined();
  });

  test("a child that already sent its own Slack reply does not get a card", async () => {
    const lead = await createAgent({ name: "Replied Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Replied Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_REPLIED_CHILD");
    const ask = await createTaskExtended("replied ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("child that already replied", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await markTaskSlackReplySent(child.id);
    await completeTask(child.id, "Child output that duplicates the Slack reply.");
    calls.length = 0;

    await processSlackRenderV2();

    expect(await getSlackOutcomeMessage(child.id)).toBeNull();
  });

  test("re-reads slackReplySent inside streamOutcomeCard so a child card doesn't duplicate a late Slack reply", async () => {
    const lead = await createAgent({
      name: "Child Stale Snapshot Lead",
      isLead: true,
      status: "idle",
    });
    const worker = await createAgent({
      name: "Child Stale Snapshot Worker",
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_CHILD_STALE_SNAPSHOT");
    const ask = await createTaskExtended("ask with a child whose reply lands before its card", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const tree = await ensureSlackThreadTree([ask.id]);
    const child = await createTaskExtended("child whose reply lands before its card", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "PRIVATE CHILD OUTPUT THAT MUST NOT DUPLICATE THE REPLY");
    // Simulate the render loop's tick-start snapshot: fetched before slack-reply
    // committed, same technique as the ask-level "stale snapshot" test above.
    const staleChildSnapshot = { ...(await getTaskById(child.id))!, slackReplySent: false };
    await markTaskSlackReplySent(child.id);
    calls.length = 0;

    const outcome = await streamOutcomeCard(staleChildSnapshot, tree!, {
      buildContent: childOutcomeContent,
    });

    const started = calls.find((call) => call.method === "chat.startStream");
    expect(started?.payload.markdown_text).toBe(`↳ ✅ ${worker.name} completed`);
    expect(started?.payload.markdown_text).not.toContain("PRIVATE CHILD OUTPUT");
    expect(outcome?.finalizedAt).toBeDefined();
  });

  test("5 simultaneous children post 3 then 2 across 2 ticks", async () => {
    const lead = await createAgent({ name: "Burst Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_BURST_5");
    const ask = await createTaskExtended("burst ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const children: AgentTask[] = [];
    for (let index = 0; index < 5; index++) {
      const worker = await createAgent({
        name: `Burst Worker ${index}`,
        isLead: false,
        status: "idle",
      });
      const child = await createTaskExtended(`burst child ${index}`, {
        agentId: worker.id,
        source: "mcp",
        parentTaskId: ask.id,
        followUpConfig: { disabled: true },
      });
      await startTask(child.id);
      await completeTask(child.id, `child ${index} output`);
      children.push(child);
    }
    calls.length = 0;

    await processSlackRenderV2();
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(3);

    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(2);

    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(0);

    for (const child of children) {
      expect((await getSlackOutcomeMessage(child.id))?.finalizedAt).toBeDefined();
    }
  });

  test("12 children stop at the 10-card-per-ask cap", async () => {
    const lead = await createAgent({ name: "Cap Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_CAP_12");
    const ask = await createTaskExtended("cap ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const children: AgentTask[] = [];
    for (let index = 0; index < 12; index++) {
      const worker = await createAgent({
        name: `Cap Worker ${index}`,
        isLead: false,
        status: "idle",
      });
      const child = await createTaskExtended(`cap child ${index}`, {
        agentId: worker.id,
        source: "mcp",
        parentTaskId: ask.id,
        followUpConfig: { disabled: true },
      });
      await startTask(child.id);
      await completeTask(child.id, `child ${index} output`);
      children.push(child);
    }
    calls.length = 0;

    for (let tick = 0; tick < 6; tick++) {
      await processSlackRenderV2();
    }

    const cardedCount = (
      await Promise.all(children.map((child) => getSlackOutcomeMessage(child.id)))
    ).filter((card) => card?.finalizedAt).length;
    expect(cardedCount).toBe(10);
  });

  test("flag off: a completed child gets no card, matching today's behavior", async () => {
    process.env.SLACK_RENDER_V2_DELEGATION = "false";
    const lead = await createAgent({ name: "Flag Off Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Flag Off Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_FLAG_OFF");
    const ask = await createTaskExtended("flag off ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("flag off child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "child output");
    calls.length = 0;

    await processSlackRenderV2();

    expect(await getSlackOutcomeMessage(child.id)).toBeNull();
  });

  test("does not apply delegation cards to tasks created before activation", async () => {
    const lead = await createAgent({ name: "Legacy Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Legacy Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_LEGACY_ACTIVATION");
    const ask = await createTaskExtended("legacy ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("legacy child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "Legacy child result.");
    await completeTask(ask.id, "Legacy ask result.");
    await getDbClient().run(
      `UPDATE slack_render_v2_state SET delegation_activated_at = ? WHERE id = 1`,
      ["2099-01-01T00:00:00.000Z"],
    );

    await processSlackRenderV2();
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
    expect(await getSlackOutcomeMessage(child.id)).toBeNull();
  });

  test("acceptance: 1 ask + 2 completed mcp children yields exactly 2 finalized child rows and 2 slack_delivery logs; re-tick adds nothing", async () => {
    const lead = await createAgent({ name: "Acceptance T3 Lead", isLead: true, status: "idle" });
    const workerA = await createAgent({
      name: "Acceptance T3 Worker A",
      isLead: false,
      status: "idle",
    });
    const workerB = await createAgent({
      name: "Acceptance T3 Worker B",
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_T3_ACCEPTANCE");
    const ask = await createTaskExtended("acceptance ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const childA = await createTaskExtended("child A", {
      agentId: workerA.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const childB = await createTaskExtended("child B", {
      agentId: workerB.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(childA.id);
    await completeTask(childA.id, "A done.");
    await startTask(childB.id);
    await completeTask(childB.id, "B done.");
    calls.length = 0;

    await processSlackRenderV2();

    const rows = await getDbClient().query<{ permalink: string | null }>(
      `SELECT permalink FROM slack_messages WHERE kind = 'outcome' AND task_id IN (?, ?)`,
      [childA.id, childB.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !!row.permalink)).toBe(true);
    const deliveryLogs = (await getLogsByEventType("slack_delivery")).filter((log) =>
      [childA.id, childB.id].includes(log.taskId ?? ""),
    );
    expect(deliveryLogs).toHaveLength(2);

    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(0);
  });

  // --- T4: deferred conclusion, timeout, reaction gate --------------------

  test("an ask that completes while a child still runs posts no card and no reaction across ticks", async () => {
    const lead = await createAgent({ name: "Open Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Open Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_OPEN_CLOSURE");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("open ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("still running child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(ask.id, "Ask output while the child keeps working.");
    calls.length = 0;

    for (let tick = 0; tick < 5; tick++) {
      await processSlackRenderV2();
    }

    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();
    expect(
      calls.some(
        (call) =>
          call.method === "reactions.add" &&
          ["white_check_mark", "x", "warning"].includes(String(call.payload.name)),
      ),
    ).toBe(false);
  });

  test("child completes, follow-up completes, and the settle window elapses: conclusion card with Results, reaction white_check_mark", async () => {
    const lead = await createAgent({ name: "Settle Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Settle Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_SETTLE");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("settle ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("do the work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "Child result body.");
    calls.length = 0;

    // Tick 1: the ask is still open, so only the child's own card posts —
    // this is what gives the conclusion card a permalink to link to below.
    await processSlackRenderV2();
    const childCard = await getSlackOutcomeMessage(child.id);
    expect(childCard?.finalizedAt).toBeDefined();
    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();

    const followUp = await createTaskExtended("[Thread follow-up] wrap up", {
      agentId: lead.id,
      source: "system",
      taskType: "follow-up",
      parentTaskId: child.id,
      followUpConfig: { disabled: true },
    });
    await startTask(followUp.id);
    await completeTask(followUp.id, "wrap-up done");
    await completeTask(ask.id, "Ask completed.");
    await backdateLastUpdated([ask.id, child.id, followUp.id], 60);
    calls.length = 0;

    // Tick 2: the closure is all-terminal and quiet — the conclusion posts.
    await processSlackRenderV2();

    const askCard = await getSlackOutcomeMessage(ask.id);
    expect(askCard?.finalizedAt).toBeDefined();
    expect(askCard?.conclusionKind).toBe("complete");
    const conclusionStream = calls.find(
      (call) =>
        call.method === "chat.startStream" &&
        String(call.payload.markdown_text).includes("**Results**"),
    );
    expect(conclusionStream).toBeDefined();
    expect(String(conclusionStream?.payload.markdown_text)).toContain(childCard!.permalink);
    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "white_check_mark", timestamp: triggerTs },
    });
  });

  test("one failed child produces reaction x", async () => {
    const lead = await createAgent({ name: "Fail Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Fail Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_FAIL_CHILD");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("fail ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("do the failing work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await failTask(child.id, "It broke.");
    await completeTask(ask.id, "Ask completed despite the failure.");
    await backdateLastUpdated([ask.id, child.id], 60);
    calls.length = 0;

    await processSlackRenderV2();

    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "x", timestamp: triggerTs },
    });
    expect((await getSlackOutcomeMessage(ask.id))?.conclusionKind).toBe("complete");
  });

  test("cancelled closure members have no card, appear in Results, and do not fail the conclusion", async () => {
    const lead = await createAgent({ name: "Cancel Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Cancel Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_CANCELLED_MEMBER");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("cancelled member ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("cancelled member", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await cancelTask(child.id, "No longer needed.");
    await completeTask(ask.id, "Ask completed.");
    await backdateLastUpdated([ask.id, child.id], 60);
    calls.length = 0;

    await processSlackRenderV2();
    expect(await getSlackOutcomeMessage(child.id)).toBeNull();
    expect((await getSlackOutcomeMessage(ask.id))?.conclusionKind).toBe("complete");
    const conclusion = calls.find(
      (call) =>
        call.method === "chat.startStream" &&
        String(call.payload.markdown_text).includes("**Results**"),
    );
    expect(String(conclusion?.payload.markdown_text)).toContain("Cancel Worker");
    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "white_check_mark", timestamp: triggerTs },
    });
  });

  test("a deferred conclusion finalizes the acknowledgement reaction on a steer message", async () => {
    const lead = await createAgent({ name: "Steer Reaction Lead", isLead: true, status: "idle" });
    const worker = await createAgent({
      name: "Steer Reaction Worker",
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_STEER_REACTION");
    const ask = await createTaskExtended("steer reaction ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: `${slackAddressSequence}.9`,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("steer reaction child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "Child result.");
    await completeTask(ask.id, "Ask result.");
    await createLogEntry({
      eventType: "task_steering",
      taskId: ask.id,
      newValue: "slack_reaction",
      metadata: { slackChannelId: channelId, slackMessageTs: `${slackAddressSequence}.8` },
    });
    await backdateLastUpdated([ask.id, child.id], 60);
    calls.length = 0;

    await processSlackRenderV2();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: {
        channel: channelId,
        name: "white_check_mark",
        timestamp: `${slackAddressSequence}.8`,
      },
    });
  });

  test("an abandoned child idle past the timeout concludes with timeout, warning, and the member listed", async () => {
    process.env.SLACK_CONCLUSION_TIMEOUT_MIN = "1";
    const lead = await createAgent({ name: "Timeout Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Timeout Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TIMEOUT");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("timeout ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("stuck work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(ask.id, "Ask completed; the child never finished.");
    await backdateLastUpdated([ask.id, child.id], 120);
    calls.length = 0;

    await processSlackRenderV2();

    const askCard = await getSlackOutcomeMessage(ask.id);
    expect(askCard?.finalizedAt).toBeDefined();
    expect(askCard?.conclusionKind).toBe("timeout");
    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "warning", timestamp: triggerTs },
    });
    const conclusionStream = calls.find(
      (call) =>
        call.method === "chat.startStream" &&
        String(call.payload.markdown_text).includes("Concluded with unfinished work"),
    );
    expect(conclusionStream).toBeDefined();
    expect(String(conclusionStream?.payload.markdown_text)).toContain(getTaskLink(child.id));
  });

  test("a stale in-progress ask times out without a completed outcome", async () => {
    process.env.SLACK_CONCLUSION_TIMEOUT_MIN = "1";
    const lead = await createAgent({ name: "Stale Ask Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_STALE_ASK_TIMEOUT");
    const ask = await createTaskExtended("stale in-progress ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    await backdateLastUpdated([ask.id], 120);
    calls.length = 0;

    await processSlackRenderV2();

    const askCard = await getSlackOutcomeMessage(ask.id);
    expect(askCard?.conclusionKind).toBe("timeout");
    const conclusionStream = calls.find((call) => call.method === "chat.startStream");
    const body = String(conclusionStream?.payload.markdown_text);
    expect(body).toContain("Concluded with unfinished work");
    expect(body).toContain("Still in progress");
    expect(body).toContain(getTaskLink(ask.id));
    expect(body).not.toContain("✅");
  });

  test("a superseded member's resume chain gates the conclusion until the resume ends", async () => {
    const lead = await createAgent({ name: "Resume Gate Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Resume Gate Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RESUME_GATE");
    const ask = await createTaskExtended("resume gate ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const crashed = await createTaskExtended("work that crashes", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(crashed.id);
    const resume = await createTaskExtended("resume the crashed work", {
      agentId: worker.id,
      source: "system",
      taskType: "resume",
      parentTaskId: crashed.id,
      followUpConfig: { disabled: true },
    });
    await supersedeTask(crashed.id, { reason: "crash_recovery", resumeTaskId: resume.id });
    await startTask(resume.id);
    await completeTask(ask.id, "Ask completed while the resume is still running.");
    await backdateLastUpdated([ask.id, crashed.id], 60);
    calls.length = 0;

    await processSlackRenderV2();
    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();

    await completeTask(resume.id, "Resume finished.");
    await backdateLastUpdated([ask.id, crashed.id, resume.id], 60);
    calls.length = 0;

    await processSlackRenderV2();
    expect((await getSlackOutcomeMessage(ask.id))?.finalizedAt).toBeDefined();
  });

  test("two asks in one thread resolve independently", async () => {
    const lead = await createAgent({ name: "Independent Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Independent Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_TWO_ASKS");
    const contextKey = slackContextKey({ channelId, threadTs });
    const first = await createTaskExtended("first ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: `${slackAddressSequence}.8`,
      contextKey,
    });
    await startTask(first.id);
    const firstChild = await createTaskExtended("first child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: first.id,
      followUpConfig: { disabled: true },
    });
    await startTask(firstChild.id);
    await completeTask(firstChild.id, "First child done.");
    await completeTask(first.id, "First ask done.");
    await backdateLastUpdated([first.id, firstChild.id], 60);

    const second = await createTaskExtended("second ask", {
      agentId: lead.id,
      source: "slack",
      parentTaskId: first.id,
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: `${slackAddressSequence}.9`,
      contextKey,
    });
    await startTask(second.id);
    const secondChild = await createTaskExtended("second child, still running", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: second.id,
      followUpConfig: { disabled: true },
    });
    await startTask(secondChild.id);
    await completeTask(second.id, "Second ask done, but its child is still running.");
    calls.length = 0;

    await processSlackRenderV2();

    expect((await getSlackOutcomeMessage(first.id))?.finalizedAt).toBeDefined();
    expect(await getSlackOutcomeMessage(second.id)).toBeNull();
  });

  test("rollback: flipping the flag off finalizes a deferred ask immediately under the old rule", async () => {
    const lead = await createAgent({ name: "Rollback Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Rollback Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_ROLLBACK");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("rollback ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("child still running at rollback", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(ask.id, "Ask completed before the rollback.");
    calls.length = 0;

    await processSlackRenderV2();
    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();

    // Rollback: the flag flips off mid-defer. The child is still running,
    // but the old rule only ever looked at tasks sharing the ask's own
    // trigger timestamp — the child never gets one — so it finalizes now.
    process.env.SLACK_RENDER_V2_DELEGATION = "false";
    calls.length = 0;

    await processSlackRenderV2();

    const askCard = await getSlackOutcomeMessage(ask.id);
    expect(askCard?.finalizedAt).toBeDefined();
    expect(askCard?.conclusionKind).toBeUndefined();
    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "white_check_mark", timestamp: triggerTs },
    });
  });

  test("acceptance: ask done + child running yields zero outcome rows across 10 ticks, then exactly one within 2 ticks after settling", async () => {
    const lead = await createAgent({ name: "Acceptance T4 Lead", isLead: true, status: "idle" });
    const worker = await createAgent({
      name: "Acceptance T4 Worker",
      isLead: false,
      status: "idle",
    });
    const { channelId, threadTs } = uniqueSlackAddress("C_T4_ACCEPTANCE");
    const ask = await createTaskExtended("acceptance ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("acceptance child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(ask.id, "Ask done; child still running.");
    calls.length = 0;

    for (let tick = 0; tick < 10; tick++) {
      await processSlackRenderV2();
    }
    const openRows = await getDbClient().query(
      `SELECT * FROM slack_messages WHERE task_id = ? AND kind = 'outcome'`,
      [ask.id],
    );
    expect(openRows).toHaveLength(0);

    await completeTask(child.id, "Child finished.");
    await backdateLastUpdated([ask.id, child.id], 60);

    let ticksToFinalize = 0;
    for (let tick = 0; tick < 2 && !(await getSlackOutcomeMessage(ask.id))?.finalizedAt; tick++) {
      await processSlackRenderV2();
      ticksToFinalize = tick + 1;
    }

    expect(ticksToFinalize).toBeLessThanOrEqual(2);
    const finalRows = await getDbClient().query<{ conclusion_kind: string | null }>(
      `SELECT conclusion_kind FROM slack_messages WHERE task_id = ? AND kind = 'outcome'`,
      [ask.id],
    );
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]?.conclusion_kind).toBe("complete");
  });

  test("ask and child both terminal before the first tick: conclusion still links the child's permalink, not a digest", async () => {
    const lead = await createAgent({ name: "First Tick Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "First Tick Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_FIRST_TICK");
    const triggerTs = `${slackAddressSequence}.9`;
    const ask = await createTaskExtended("first tick ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("first tick child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    // Both members reach a terminal state before processSlackRenderV2 ever
    // runs for this thread — there is no earlier tick in which the child
    // could have picked up its own card first.
    await completeTask(child.id, "Child result body.");
    await completeTask(ask.id, "Ask completed.");
    await backdateLastUpdated([ask.id, child.id], 60);
    calls.length = 0;

    await processSlackRenderV2();

    const childCard = await getSlackOutcomeMessage(child.id);
    expect(childCard?.finalizedAt).toBeDefined();
    const askCard = await getSlackOutcomeMessage(ask.id);
    expect(askCard?.finalizedAt).toBeDefined();
    expect(askCard?.conclusionKind).toBe("complete");
    const conclusionStream = calls.find(
      (call) =>
        call.method === "chat.startStream" &&
        String(call.payload.markdown_text).includes("**Results**"),
    );
    expect(conclusionStream).toBeDefined();
    expect(String(conclusionStream?.payload.markdown_text)).toContain(childCard!.permalink);
    expect(String(conclusionStream?.payload.markdown_text)).not.toContain(getTaskLink(child.id));
  });

  test("defers a conclusion until overflow child cards are posted", async () => {
    const lead = await createAgent({ name: "Overflow Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Overflow Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_OVERFLOW_ORDER");
    const ask = await createTaskExtended("overflow ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const children = [];
    for (let index = 0; index < 4; index++) {
      const child = await createTaskExtended(`overflow child ${index}`, {
        agentId: worker.id,
        source: "mcp",
        parentTaskId: ask.id,
        followUpConfig: { disabled: true },
      });
      await startTask(child.id);
      await completeTask(child.id, `Child ${index} result.`);
      children.push(child);
    }
    await completeTask(ask.id, "Ask completed.");
    await backdateLastUpdated([ask.id, ...children.map((child) => child.id)], 60);
    calls.length = 0;

    await processSlackRenderV2();
    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();
    expect(
      (await Promise.all(children.map((child) => getSlackOutcomeMessage(child.id)))).filter(
        (card) => card?.finalizedAt,
      ),
    ).toHaveLength(3);

    calls.length = 0;
    await processSlackRenderV2();
    const askCard = await getSlackOutcomeMessage(ask.id);
    expect(askCard?.finalizedAt).toBeDefined();
    expect(
      (await Promise.all(children.map((child) => getSlackOutcomeMessage(child.id)))).filter(
        (card) => card?.finalizedAt,
      ),
    ).toHaveLength(4);
    const conclusion = calls.find(
      (call) =>
        call.method === "chat.startStream" &&
        String(call.payload.markdown_text).includes("**Results**"),
    );
    expect(conclusion).toBeDefined();
    for (const child of children) {
      expect(String(conclusion?.payload.markdown_text)).toContain(
        (await getSlackOutcomeMessage(child.id))?.permalink,
      );
    }
  });
});
