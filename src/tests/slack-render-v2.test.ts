import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getSlackOutcomeMessage,
  getSlackTreeMessage,
  initDb,
  startTask,
} from "../be/db";
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

function uniqueSlackAddress(label: string): { channelId: string; threadTs: string } {
  slackAddressSequence++;
  return {
    channelId: `${label}_${slackAddressSequence}`,
    threadTs: `${slackAddressSequence}.1`,
  };
}

const mockApiCall = mock(async (method: string, payload: Record<string, unknown>) => {
  calls.push({ method, payload });
  if (method === "chat.postMessage") return { ok: true, ts: `tree.${++treeCounter}` };
  if (method === "chat.startStream") return { ok: true, ts: `outcome.${++outcomeCounter}` };
  if (method === "chat.appendStream" && appendCallsUntilFailure !== undefined) {
    if (appendCallsUntilFailure === 0) {
      appendCallsUntilFailure = undefined;
      throw new Error("temporary append failure");
    }
    appendCallsUntilFailure--;
  }
  if (method === "chat.getPermalink") {
    if (permalinkFailuresRemaining > 0) {
      permalinkFailuresRemaining--;
      throw new Error("temporary permalink failure");
    }
    return {
      ok: true,
      permalink: `https://workspace.slack.com/archives/${payload.channel}/p${String(payload.message_ts).replaceAll(".", "")}`,
    };
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

beforeAll(async () => {
  await removeDbFiles();
  process.env.APP_URL = "https://app.agent-swarm.dev";
  process.env.SLACK_RENDER_V2 = "true";
  initDb(TEST_DB_PATH);
});

beforeEach(() => {
  calls.length = 0;
  mockApiCall.mockClear();
  appendCallsUntilFailure = undefined;
  permalinkFailuresRemaining = 0;
  _resetSlackRenderV2ForTests();
});

afterAll(async () => {
  _resetSlackRenderV2ForTests();
  closeDb();
  await removeDbFiles();
});

describe("Slack renderer v2", () => {
  test("defaults on and accepts an explicit off switch", () => {
    const previous = process.env.SLACK_RENDER_V2;
    delete process.env.SLACK_RENDER_V2;
    expect(isSlackRenderV2Enabled()).toBe(true);
    process.env.SLACK_RENDER_V2 = "false";
    expect(isSlackRenderV2Enabled()).toBe(false);
    if (previous === undefined) delete process.env.SLACK_RENDER_V2;
    else process.env.SLACK_RENDER_V2 = previous;
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

    calls.length = 0;
    const recovered = await ensureSlackThreadTree([ask.id]);
    expect(recovered?.ts).toBe(persisted?.ts);
    expect(recovered?.permalink).toContain("workspace.slack.com");
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false);
    _resetSlackRenderV2ForTests();
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

    const tree = await ensureSlackThreadTree([first.id]);
    const reused = await ensureSlackThreadTree([second.id]);

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

    expect(text).toContain("🧵 *format tests* · 8m05s");
    expect(text).toContain(
      `├─ ⏳ format tests · 8m05s · <https://app.agent-swarm.dev/tasks/${ask.id}|\`${ask.id.slice(0, 8)}\`>`,
    );
    expect(text).toContain("│  └─ ⏳ Researcher");
    expect(text).toContain("│     └─ ⏳ Researcher");
    expect(text).toContain("└─ ⏳ this PR");
    expect(text).not.toContain("```");
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
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.getPermalink",
      "chat.update",
    ]);

    const started = calls.find(
      (call) => call.method === "chat.startStream" && call.payload.channel === channelId,
    )!;
    expect(started.payload).toMatchObject({
      channel: channelId,
      thread_ts: threadTs,
      recipient_user_id: "U_REQUESTER",
      recipient_team_id: "T_TEST",
    });
    const stopped = calls.find(
      (call) => call.method === "chat.stopStream" && call.payload.channel === channelId,
    )!;
    expect(stopped.payload.blocks).toEqual([
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: expect.stringContaining("1 worker"),
          },
        ],
      },
    ]);

    const treeUpdate = calls.find(
      (call) => call.method === "chat.update" && call.payload.channel === channelId,
    )!;
    expect(treeUpdate.payload.ts).toBe(firstTree?.ts);
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

  test("updates a failed top-level ask in place without creating an outcome card", async () => {
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
    failTask(ask.id, "expected test failure");
    calls.length = 0;
    _resetSlackRenderV2ForTests();

    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    const update = calls.find(
      (call) => call.method === "chat.update" && call.payload.ts === tree?.ts,
    );
    expect(update?.payload.ts).toBe(tree?.ts);
    expect(update?.payload.text).toContain("└─ ❌ failing ask");
  });

  test("resumes an unfinished persisted outcome stream without starting a duplicate", async () => {
    const lead = createAgent({ name: "Recovery Lead", isLead: true, status: "idle" });
    const { channelId, threadTs } = uniqueSlackAddress("C_RENDER_RECOVERY");
    const ask = createTaskExtended("recover streamed outcome", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      contextKey: slackContextKey({ channelId, threadTs }),
    });
    startTask(ask.id);
    await ensureSlackThreadTree([ask.id]);
    completeTask(ask.id, "Recovered the outcome stream after a temporary interruption.");
    calls.length = 0;
    _resetSlackRenderV2ForTests();
    appendCallsUntilFailure = 1;

    await processSlackRenderV2();

    const interrupted = getSlackOutcomeMessage(ask.id);
    expect(interrupted?.finalizedAt).toBeUndefined();
    expect(interrupted?.streamChunksAppended).toBe(1);
    expect(calls.filter((call) => call.method === "chat.startStream")).toHaveLength(1);

    calls.length = 0;
    _resetSlackRenderV2ForTests();
    await processSlackRenderV2();

    expect(calls.some((call) => call.method === "chat.startStream")).toBe(false);
    expect(calls.filter((call) => call.method === "chat.appendStream")).toHaveLength(2);
    expect(calls.some((call) => call.method === "chat.stopStream")).toBe(true);
    expect(getSlackOutcomeMessage(ask.id)?.finalizedAt).toBeDefined();
  });
});
