import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  ensureSlackDelegationActivation,
  ensureSlackRenderV2Activation,
  getDbClient,
  getLogsByEventType,
  getSlackOutcomeMessage,
  getSlackTreeMessageByThread,
  initDb,
  isPendingSlackMessage,
  startTask,
} from "../be/db";
import { _resetSlackRenderV2ForTests, processSlackRenderV2 } from "../slack/render-v2";
import { slackContextKey } from "../tasks/context-key";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";

// End-to-end coverage for T6 (plan section 5): the full delegation story —
// ask created, tree posts, a child is dispatched and completes, its card
// posts, the follow-up settles the closure, the conclusion card and reaction
// finalize — plus a crash-recovery case between `chat.startStream` and the
// timestamp bind. This complements the unit-level T3/T4 coverage already in
// `slack-render-v2.test.ts`; it drives the same in-process
// `processSlackRenderV2` loop against a mock Slack `WebClient` and a real
// temp SQLite file, one file per this test module so `bun test --parallel=4`
// never collides with another test file's DB.

const TEST_DB_PATH = "./test-slack-render-v2-delegation.sqlite";
const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
let treeCounter = 0;
let outcomeCounter = 0;
let slackAddressSequence = 0;

type RemoteMessage = {
  channel: string;
  threadTs: string;
  ts: string;
  text: string;
  streaming?: boolean;
};

const remoteMessages = new Map<string, RemoteMessage>();

function remoteKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

function uniqueSlackAddress(label: string): { channelId: string; threadTs: string } {
  slackAddressSequence++;
  return {
    channelId: `${label}_${slackAddressSequence}`,
    threadTs: `${slackAddressSequence}.1`,
  };
}

/**
 * `closureState` reads real time via `new Date()`. Tests inject "elapsed
 * time" by moving the stored `lastUpdatedAt` into the past instead of
 * sleeping, matching the pattern in `slack-render-v2.test.ts`.
 */
async function backdateLastUpdated(taskIds: string[], secondsAgo: number): Promise<void> {
  const ts = new Date(Date.now() - secondsAgo * 1_000).toISOString();
  for (const id of taskIds) {
    await getDbClient().run(`UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?`, [ts, id]);
  }
}

const mockApiCall = mock(async (method: string, payload: Record<string, unknown>) => {
  calls.push({ method, payload });
  if (method === "conversations.replies") {
    return {
      ok: true,
      messages: [...remoteMessages.values()]
        .filter((message) => message.channel === payload.channel && message.threadTs === payload.ts)
        .map((message) => ({ ...message })),
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
    if (!remoteMessages.has(remoteKey(String(payload.channel), String(payload.message_ts)))) {
      throw { data: { error: "message_not_found" } };
    }
    return {
      ok: true,
      permalink: `https://workspace.slack.com/archives/${payload.channel}/p${String(payload.message_ts).replaceAll(".", "")}`,
    };
  }
  if (method === "chat.update") {
    const message = remoteMessages.get(remoteKey(String(payload.channel), String(payload.ts)));
    if (!message) throw { data: { error: "message_not_found" } };
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
  process.env.SLACK_RENDER_V2_DELEGATION = "true";
  // Pre-activate so every fixture task, created after this point, is a
  // post-activation task (matches a real deployment: flag flipped on, then
  // work dispatched). The lazy activation call inside processSlackRenderV2
  // is a no-op once this row already exists.
  await ensureSlackDelegationActivation();
  calls.length = 0;
  remoteMessages.clear();
  treeCounter = 0;
  outcomeCounter = 0;
  mockApiCall.mockClear();
  _resetSlackRenderV2ForTests();
});

afterEach(() => {
  delete process.env.SLACK_RENDER_V2_DELEGATION;
  delete process.env.SLACK_CONCLUSION_SETTLE_SEC;
  delete process.env.SLACK_CONCLUSION_TIMEOUT_MIN;
});

afterAll(async () => {
  _resetSlackRenderV2ForTests();
  closeDb();
  await removeDbFiles();
});

describe("Slack render v2 delegation — full pipeline (T6)", () => {
  test("ask created, tree posts, child dispatched, glyphs update, child card posts, follow-up settles, conclusion posts, reaction finalizes", async () => {
    const lead = await createAgent({ name: "Pipeline Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Pipeline Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_FULL_PIPELINE");
    const triggerTs = `${slackAddressSequence}.9`;

    // 1. Ask created.
    const ask = await createTaskExtended("research X and delegate the work", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackTriggerMessageTs: triggerTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);

    // 2. Tree posts, and the ask's line carries the running glyph.
    await processSlackRenderV2();
    const treeAfterAskStart = await getSlackTreeMessageByThread(channelId, threadTs);
    expect(treeAfterAskStart).not.toBeNull();
    const treeTextAfterAskStart = remoteMessages.get(
      remoteKey(channelId, treeAfterAskStart!.ts),
    )?.text;
    expect(treeTextAfterAskStart).toContain("🔄");
    expect(treeTextAfterAskStart).toContain("🧵 🔄 working");

    // 3. Child dispatched (delegated worker task, still running).
    const child = await createTaskExtended("delegate: research X", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await processSlackRenderV2();

    // 4. Glyphs update: both ask and child show the running glyph, no card
    //    or reaction yet — the closure is still open.
    const treeWhileChildRuns = await getSlackTreeMessageByThread(channelId, threadTs);
    const treeTextWhileChildRuns = remoteMessages.get(
      remoteKey(channelId, treeWhileChildRuns!.ts),
    )?.text;
    expect(treeTextWhileChildRuns).toContain("🔄");
    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();
    expect(await getSlackOutcomeMessage(child.id)).toBeNull();
    expect(calls.some((call) => call.method === "reactions.add")).toBe(false);

    // 5. Child completes.
    await completeTask(child.id, "Found the X result.");
    calls.length = 0;
    await processSlackRenderV2();

    // 6. Child card posts.
    const childCard = await getSlackOutcomeMessage(child.id);
    expect(childCard?.finalizedAt).toBeDefined();
    const childCardText = calls.find(
      (call) => call.method === "chat.startStream" && call.payload.thread_ts === threadTs,
    )?.payload.markdown_text;
    expect(String(childCardText)).toContain("↳ ✅ Pipeline Worker — result");
    expect(await getSlackOutcomeMessage(ask.id)).toBeNull();

    // 7. Follow-up task completes (the lead's wrap-up after the child ends).
    const followUp = await createTaskExtended("[Thread follow-up] wrap up", {
      agentId: lead.id,
      source: "system",
      taskType: "follow-up",
      parentTaskId: child.id,
      followUpConfig: { disabled: true },
    });
    await startTask(followUp.id);
    await completeTask(followUp.id, "Wrap-up complete.");
    await completeTask(ask.id, "Delegated the work and it is done.");

    // 8. Settle: every closure member is terminal; back-date so the settle
    //    window (default 10s) has elapsed without a real sleep.
    await backdateLastUpdated([ask.id, child.id, followUp.id], 60);
    calls.length = 0;
    await processSlackRenderV2();

    // 9. Conclusion card posts with a Results section linking the child card.
    const conclusionCard = await getSlackOutcomeMessage(ask.id);
    expect(conclusionCard?.finalizedAt).toBeDefined();
    expect(conclusionCard?.conclusionKind).toBe("complete");
    const conclusionText = calls.find(
      (call) =>
        call.method === "chat.startStream" &&
        String(call.payload.markdown_text).includes("**Results**"),
    )?.payload.markdown_text;
    expect(conclusionText).toBeDefined();
    expect(String(conclusionText)).toContain(childCard!.permalink);

    // 10. Reaction finalizes to white_check_mark only now — not earlier.
    expect(calls).toContainEqual({
      method: "reactions.add",
      payload: { channel: channelId, name: "white_check_mark", timestamp: triggerTs },
    });

    // 11. Final tree shows every member as done, and the header reads done.
    const finalTree = await getSlackTreeMessageByThread(channelId, threadTs);
    const finalTreeText = remoteMessages.get(remoteKey(channelId, finalTree!.ts))?.text;
    expect(finalTreeText).toContain("🧵 ✅ done");

    // 12. Observability trail (plan section 3.10): a slack_delivery log per
    //     finalize, for both the child outcome and the conclusion.
    const childDeliveryLogs = (await getLogsByEventType("slack_delivery")).filter(
      (log) => log.taskId === child.id && log.newValue === "child_outcome",
    );
    const conclusionDeliveryLogs = (await getLogsByEventType("slack_delivery")).filter(
      (log) => log.taskId === ask.id && log.newValue === "conclusion",
    );
    expect(childDeliveryLogs).toHaveLength(1);
    expect(conclusionDeliveryLogs).toHaveLength(1);

    // 13. Re-tick is a no-op: no duplicate cards, no duplicate reaction.
    calls.length = 0;
    await processSlackRenderV2();
    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    expect(calls.some((call) => call.method === "reactions.add")).toBe(false);
  });
});

describe("Slack render v2 delegation — crash recovery (T6)", () => {
  test("kill between chat.startStream and the timestamp bind: restart reconciles the child card without a duplicate post", async () => {
    const lead = await createAgent({ name: "Crash Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Crash Worker", isLead: false, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_CHILD_BIND_CRASH");
    const ask = await createTaskExtended("survive a child card bind crash", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    await startTask(ask.id);
    const child = await createTaskExtended("do the work that will crash mid-bind", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    await startTask(child.id);
    await completeTask(child.id, "Result body that must survive the crash.");
    calls.length = 0;

    // Simulate a process kill after `chat.startStream` posts the message but
    // before `bindSlackMessageTimestamp` persists its real ts — the same
    // technique the existing ask-level crash test in
    // `slack-render-v2.test.ts` uses for the outcome row.
    await getDbClient().run(`CREATE TRIGGER fail_child_timestamp_bind
      BEFORE UPDATE OF ts ON slack_messages
      WHEN OLD.kind = 'outcome' AND OLD.ts LIKE 'pending:%'
      BEGIN SELECT RAISE(ABORT, 'simulated child bind crash'); END`);

    await processSlackRenderV2();

    const pending = (await getSlackOutcomeMessage(child.id))!;
    expect(isPendingSlackMessage(pending)).toBe(true);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);

    // "Restart the loop": drop the trigger (the process would come back up
    // clean) and re-tick. `findReservedSlackMessage` must reconcile the
    // already-posted message by its metadata marker instead of re-posting.
    await getDbClient().run("DROP TRIGGER fail_child_timestamp_bind");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    const reconciled = await getSlackOutcomeMessage(child.id);
    expect(reconciled?.id).toBe(pending.id);
    expect(reconciled?.finalizedAt).toBeDefined();
    expect(
      [...remoteMessages.values()].filter(
        (message) => message.channel === channelId && message.ts.startsWith("outcome."),
      ),
    ).toHaveLength(1);
  });
});
