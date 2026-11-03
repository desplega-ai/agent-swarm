/**
 * A top-level message in a 1:1 DM with the bot is addressed to the bot even
 * without an @-mention. Bolt's Assistant middleware claims only DM messages
 * that carry `thread_ts`, so a top-level DM reaches registerMessageHandler,
 * which used to drop it as `not_addressed` unless it tagged the bot.
 *
 * These tests drive the real message handler and read the delivery outcome.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as dbModule from "../be/db";
import * as slackEnrichModule from "../slack/enrich";
import * as slackEventDedupModule from "../slack/event-dedup";
import { runAdmittedSlackDelivery } from "../slack/inbound-dispatch";
import * as inboundFilesModule from "../slack/inbound-files";
import * as siblingAwarenessModule from "../tasks/sibling-awareness";

const BOT_USER_ID = "U_BOT_DM_IMPLICIT";
const OTHER_USER_ID = "U0831BS93V1";
const LEAD = { id: "lead-dm-implicit-1", name: "TestLead", isLead: true, status: "idle" };

const originalEnv = {
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_ALLOWED_EMAIL_DOMAINS: process.env.SLACK_ALLOWED_EMAIL_DOMAINS,
  SLACK_ALLOWED_USER_IDS: process.env.SLACK_ALLOWED_USER_IDS,
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
  SLACK_THREAD_WAKE_ON_ANY_MESSAGE: process.env.SLACK_THREAD_WAKE_ON_ANY_MESSAGE,
};

type MessageEventArg = {
  channel: string;
  channel_type?: string;
  ts: string;
  text?: string;
  user?: string;
  subtype?: string;
  thread_ts?: string;
  files?: Array<{ id: string; name: string; mimetype: string; size: number }>;
};

type HandlerArgs = {
  event: MessageEventArg;
  body: Record<string, unknown>;
  client: typeof mockClient;
  say: (args: unknown) => Promise<void>;
};

const mockClient = {
  auth: { test: async () => ({ user_id: BOT_USER_ID, bot_id: "B_BOT_DM_IMPLICIT" }) },
  conversations: { replies: async () => ({ messages: [], ok: true }) },
  reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  chat: { postMessage: async () => ({ ok: true }) },
};

let createTaskSpy: any;
let getAllAgentsSpy: any;
let fetchSlackFilesSpy: any;
const spies: any[] = [];
let handler: (args: HandlerArgs) => Promise<void>;
let resetCaches: () => void;
let sequence = 0;

function emptyInbound(files: inboundFilesModule.InboundSlackFiles["files"] = []) {
  return {
    files,
    fetched: [],
    failed: [],
    async [Symbol.asyncDispose]() {},
  } as inboundFilesModule.InboundSlackFiles;
}

function installSpyImplementations(): void {
  createTaskSpy.mockImplementation(async () => ({ id: "mock-task-dm-implicit" }));
  getAllAgentsSpy.mockImplementation(async () => [LEAD]);
  fetchSlackFilesSpy.mockImplementation(async (_client: unknown, files: unknown) =>
    emptyInbound((files as inboundFilesModule.InboundSlackFiles["files"]) ?? []),
  );
}

async function deliver(event: Omit<MessageEventArg, "ts" | "user">) {
  sequence += 1;
  const ts = `2000000002.${String(sequence).padStart(6, "0")}`;
  // A distinct sender per message keeps the per-user rate limit out of play.
  const user = `U_HUMAN_DM_${sequence}`;
  const outcome = await runAdmittedSlackDelivery("socket", () =>
    handler({
      event: { ...event, ts, user },
      body: { event_id: `evt_dm_implicit_${sequence}` },
      client: mockClient,
      say: mock(async () => {}),
    }),
  );
  return { outcome, ts };
}

beforeAll(async () => {
  process.env.ADDITIVE_SLACK = "false";
  process.env.SLACK_RENDER_V2 = "false";
  delete process.env.SLACK_ALLOWED_EMAIL_DOMAINS;
  delete process.env.SLACK_ALLOWED_USER_IDS;
  delete process.env.SLACK_THREAD_WAKE_ON_ANY_MESSAGE;

  createTaskSpy = spyOn(siblingAwarenessModule, "createTaskWithSiblingAwareness");
  getAllAgentsSpy = spyOn(dbModule, "getAllAgents");
  fetchSlackFilesSpy = spyOn(inboundFilesModule, "fetchSlackFiles");
  spies.push(
    createTaskSpy,
    getAllAgentsSpy,
    fetchSlackFilesSpy,
    spyOn(dbModule, "getAgentWorkingOnThread").mockImplementation(async () => null),
    spyOn(dbModule, "getLeadAgent").mockImplementation(async () => LEAD as any),
    spyOn(dbModule, "getAgentById").mockImplementation(async (id: string) =>
      id === LEAD.id ? (LEAD as any) : null,
    ),
    spyOn(dbModule, "getMostRecentTaskInThread").mockImplementation(async () => null),
    spyOn(dbModule, "getTasksByAgentId").mockImplementation(async () => []),
    spyOn(slackEnrichModule, "resolveSlackUserId").mockImplementation(async () => undefined),
    spyOn(slackEnrichModule, "enrichSlackUserEmail").mockImplementation(async () => null),
    spyOn(slackEventDedupModule, "wasEventSeen").mockImplementation(() => false),
  );
  installSpyImplementations();

  const handlers = await import("../slack/handlers");
  resetCaches = handlers.resetSlackHandlerCachesForTesting;
  resetCaches();
  handlers.registerMessageHandler({
    event: (eventType: string, fn: (args: HandlerArgs) => Promise<void>) => {
      if (eventType === "message") handler = fn;
    },
  } as any);
});

beforeEach(() => {
  for (const spy of spies) spy.mockClear();
  installSpyImplementations();
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restore();
  resetCaches();
});

describe("registerMessageHandler — top-level 1:1 DM is addressed to the bot", () => {
  test("untagged top-level DM creates a Lead task", async () => {
    const { outcome, ts } = await deliver({
      channel: "D_DM_IMPLICIT",
      channel_type: "im",
      text: "Can you check why the nightly digest did not post?",
    });

    expect(outcome.state).toBe("processed");
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    const [description, options] = createTaskSpy.mock.calls[0];
    expect(description).toContain("Can you check why the nightly digest did not post?");
    expect(options).toMatchObject({ agentId: LEAD.id, slackTriggerMessageTs: ts });
  });

  test("untagged top-level DM creates a Lead task when no agent is online", async () => {
    getAllAgentsSpy.mockImplementation(async () => []);
    const { outcome } = await deliver({
      channel: "D_DM_IMPLICIT",
      channel_type: "im",
      text: "Queue this for later please",
    });

    expect(outcome.state).toBe("processed");
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    expect(createTaskSpy.mock.calls[0][1]).toMatchObject({ agentId: LEAD.id });
  });

  test("untagged top-level DM with a file upload plus text creates a task", async () => {
    const { outcome } = await deliver({
      channel: "D_DM_IMPLICIT",
      channel_type: "im",
      subtype: "file_share",
      text: "What is wrong in this screenshot?",
      files: [{ id: "F_DM_IMPLICIT", name: "shot.png", mimetype: "image/png", size: 2048 }],
    });

    expect(outcome.state).toBe("processed");
    expect(fetchSlackFilesSpy).toHaveBeenCalledTimes(1);
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    const [description, options] = createTaskSpy.mock.calls[0];
    expect(description).toContain("What is wrong in this screenshot?");
    expect(description).toContain("shot.png");
    expect(options).toMatchObject({ agentId: LEAD.id });
  });

  test("DM that tags only another user creates no task", async () => {
    const { outcome } = await deliver({
      channel: "D_DM_IMPLICIT",
      channel_type: "im",
      text: `<@${OTHER_USER_ID}> can you take a look?`,
    });

    expect(outcome).toEqual({ state: "ignored", code: "not_addressed" });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  test("untagged top-level channel message stays not_addressed", async () => {
    const { outcome } = await deliver({
      channel: "C_CHANNEL_IMPLICIT",
      channel_type: "channel",
      text: "Can you check why the nightly digest did not post?",
    });

    expect(outcome).toEqual({ state: "ignored", code: "not_addressed" });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  test("untagged top-level group DM (mpim) message stays not_addressed", async () => {
    const { outcome } = await deliver({
      channel: "G_MPIM_IMPLICIT",
      channel_type: "mpim",
      text: "Can you check why the nightly digest did not post?",
    });

    expect(outcome).toEqual({ state: "ignored", code: "not_addressed" });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  test("untagged DM thread reply with no swarm activity stays not_addressed", async () => {
    const { outcome } = await deliver({
      channel: "D_DM_IMPLICIT",
      channel_type: "im",
      thread_ts: "2000000001.000001",
      text: "Following up on this",
    });

    expect(outcome).toEqual({ state: "ignored", code: "not_addressed" });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });
});
