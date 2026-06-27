/**
 * Production-path regression tests for the assistant-surface co-mention guard.
 *
 * These tests invoke the REAL production handlers (createAssistant().userMessage and
 * the registerMessageHandler callback) to verify that task creation is suppressed
 * when a Slack message @-mentions a different agent (e.g. Devin) but NOT our bot.
 *
 * Mutation resistance: removing the guard from src/slack/assistant.ts or
 * src/slack/handlers.ts causes the co-mention message to reach
 * createTaskWithSiblingAwareness, which fails the `not.toHaveBeenCalled()` assertions.
 *
 * Complements slack-assistant-comention.test.ts (pure helper-function unit tests).
 * Regression for task 4ae1f3b5 — "<@U0831BS93V1> Are you here?" spawned an unwanted task.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as dbModule from "../be/db";
import * as slackEnrichModule from "../slack/enrich";
import * as slackEventDedupModule from "../slack/event-dedup";
import * as siblingAwarenessModule from "../tasks/sibling-awareness";

// ---------------------------------------------------------------------------
// Production-handler spies.
//
// Avoid mock.module here: Bun's module overrides are process-global and can be
// observed by other test files during module loading. Restorable spies keep the
// regression test on the real production handlers without leaking fake modules.
// ---------------------------------------------------------------------------

let createAssistantFn: typeof import("../slack/assistant").createAssistant;
let registerMessageHandlerFn: typeof import("../slack/handlers").registerMessageHandler;

let createTaskWithSiblingAwarenessSpy: any;
let getAgentWorkingOnThreadSpy: any;
let getLeadAgentSpy: any;
let getMostRecentTaskInThreadSpy: any;
let getAgentByIdSpy: any;
let getTasksByAgentIdSpy: any;
let resolveSlackUserIdSpy: any;
let enrichSlackUserEmailSpy: any;
let wasEventSeenSpy: any;

const originalEnv = {
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_ALLOWED_EMAIL_DOMAINS: process.env.SLACK_ALLOWED_EMAIL_DOMAINS,
  SLACK_ALLOWED_USER_IDS: process.env.SLACK_ALLOWED_USER_IDS,
};

function restoreEnvValue(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function installSpyImplementations(): void {
  createTaskWithSiblingAwarenessSpy.mockImplementation(() => ({ id: "mock-task-id-prod-path" }));
  getAgentWorkingOnThreadSpy.mockImplementation(() => null);
  getLeadAgentSpy.mockImplementation(() => ({
    id: "lead-prod-test-1",
    name: "TestLead",
    isLead: true,
  }));
  getMostRecentTaskInThreadSpy.mockImplementation(() => null);
  getAgentByIdSpy.mockImplementation(() => null);
  getTasksByAgentIdSpy.mockImplementation(() => []);
  resolveSlackUserIdSpy.mockImplementation(async () => undefined);
  enrichSlackUserEmailSpy.mockImplementation(async () => null);
  wasEventSeenSpy.mockImplementation(() => false);
}

beforeAll(async () => {
  process.env.ADDITIVE_SLACK = "false";
  delete process.env.SLACK_ALLOWED_EMAIL_DOMAINS;
  delete process.env.SLACK_ALLOWED_USER_IDS;

  createTaskWithSiblingAwarenessSpy = spyOn(
    siblingAwarenessModule,
    "createTaskWithSiblingAwareness",
  );
  getAgentWorkingOnThreadSpy = spyOn(dbModule, "getAgentWorkingOnThread");
  getLeadAgentSpy = spyOn(dbModule, "getLeadAgent");
  getMostRecentTaskInThreadSpy = spyOn(dbModule, "getMostRecentTaskInThread");
  getAgentByIdSpy = spyOn(dbModule, "getAgentById");
  getTasksByAgentIdSpy = spyOn(dbModule, "getTasksByAgentId");
  resolveSlackUserIdSpy = spyOn(slackEnrichModule, "resolveSlackUserId");
  enrichSlackUserEmailSpy = spyOn(slackEnrichModule, "enrichSlackUserEmail");
  wasEventSeenSpy = spyOn(slackEventDedupModule, "wasEventSeen");

  installSpyImplementations();

  ({ createAssistant: createAssistantFn } = await import("../slack/assistant"));
  ({ registerMessageHandler: registerMessageHandlerFn } = await import("../slack/handlers"));
});

beforeEach(() => {
  createTaskWithSiblingAwarenessSpy.mockClear();
  getAgentWorkingOnThreadSpy.mockClear();
  getLeadAgentSpy.mockClear();
  getMostRecentTaskInThreadSpy.mockClear();
  getAgentByIdSpy.mockClear();
  getTasksByAgentIdSpy.mockClear();
  resolveSlackUserIdSpy.mockClear();
  enrichSlackUserEmailSpy.mockClear();
  wasEventSeenSpy.mockClear();
  installSpyImplementations();
});

afterAll(() => {
  restoreEnvValue("ADDITIVE_SLACK");
  restoreEnvValue("SLACK_ALLOWED_EMAIL_DOMAINS");
  restoreEnvValue("SLACK_ALLOWED_USER_IDS");
  mock.restore();
});

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BOT_USER_ID = "U_BOT_PROD_TEST";
const DEVIN_USER_ID = "U0831BS93V1"; // the other agent from the original regression
let slackDeliverySequence = 0;

function nextSlackDelivery(eventIdPrefix: string): { eventId: string; ts: string } {
  slackDeliverySequence += 1;
  return {
    eventId: `${eventIdPrefix}_${slackDeliverySequence}`,
    ts: `2000000001.${String(slackDeliverySequence).padStart(6, "0")}`,
  };
}

// Mock Slack WebClient — auth.test() returns our bot's user ID so the
// module-level cachedBotUserId gets populated on the first handler invocation.
const mockClient = {
  auth: {
    test: async () => ({ user_id: BOT_USER_ID, bot_id: "B_BOT_PROD_TEST" }),
  },
  conversations: {
    // Needed only if getThreadContext is reached (thread_ts set); returning
    // empty messages is safe for the paths exercised here.
    replies: async () => ({ messages: [], ok: true }),
  },
};

// ---------------------------------------------------------------------------
// Production-path: assistant.ts — createAssistant().userMessage
// ---------------------------------------------------------------------------

describe("assistant.ts — userMessage production-path co-mention guard", () => {
  // Access the registered middleware function directly.
  // Bolt stores handlers as an array; [0] is the callback passed to the config.
  let userMessageHandler: (args: Record<string, unknown>) => Promise<void>;

  beforeAll(() => {
    userMessageHandler = (createAssistantFn() as any).userMessage[0] as typeof userMessageHandler;
  });

  test("does NOT spawn a task when message @-mentions another agent but not our bot", async () => {
    await userMessageHandler({
      message: {
        channel: "D_ASSISTANT_PROD_TEST",
        ts: "1000000001.000001",
        text: `<@${DEVIN_USER_ID}> Are you here?`,
        user: "U_HUMAN_ASST_001",
      },
      body: { event_id: "evt_prod_asst_comention_001" },
      say: mock(async () => {}),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
      client: mockClient,
    });

    expect(createTaskWithSiblingAwarenessSpy).not.toHaveBeenCalled();
  });

  test("DOES spawn a task for a plain DM with no @-mentions (baseline)", async () => {
    await userMessageHandler({
      message: {
        channel: "D_ASSISTANT_PROD_TEST",
        ts: "1000000001.000002",
        text: "What is the current status of all agents?",
        user: "U_HUMAN_ASST_001",
      },
      body: { event_id: "evt_prod_asst_plain_001" },
      say: mock(async () => {}),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
      client: mockClient,
    });

    expect(createTaskWithSiblingAwarenessSpy).toHaveBeenCalledTimes(1);
  });

  test("does NOT spawn a task when message @-mentions a human user but not our bot", async () => {
    await userMessageHandler({
      message: {
        channel: "D_ASSISTANT_PROD_TEST",
        ts: "1000000001.000003",
        text: "<@U037TJB7VHQ> what do you think?",
        user: "U_HUMAN_ASST_001",
      },
      body: { event_id: "evt_prod_asst_comention_002" },
      say: mock(async () => {}),
      setStatus: mock(async () => {}),
      setTitle: mock(async () => {}),
      getThreadContext: mock(async () => ({})),
      client: mockClient,
    });

    expect(createTaskWithSiblingAwarenessSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Production-path: handlers.ts — registerMessageHandler, assistant_thread fallback
//
// File-share messages in DM assistant threads bypass the Assistant handler and
// land in the generic message handler. The isImplicitMention logic in
// registerMessageHandler must suppress task creation when assistant_thread is set
// AND the message @-mentions a different user (not our bot).
// ---------------------------------------------------------------------------

describe("registerMessageHandler — assistant_thread co-mention guard (production-path)", () => {
  type MessageEventArg = {
    channel: string;
    ts: string;
    text?: string;
    user?: string;
    subtype?: string;
    bot_id?: string;
    assistant_thread?: Record<string, unknown>;
    thread_ts?: string;
  };

  type HandlerArgs = {
    event: MessageEventArg;
    body: Record<string, unknown>;
    client: typeof mockClient;
    say: (args: unknown) => Promise<void>;
  };

  let capturedHandler: ((args: HandlerArgs) => Promise<void>) | null = null;

  beforeAll(() => {
    const mockApp = {
      event: (eventType: string, handler: (args: HandlerArgs) => Promise<void>) => {
        // registerMessageHandler calls app.event("message", ...) and then
        // app.event("app_mention", ...). Capture only the message handler.
        if (eventType === "message") {
          capturedHandler = handler;
        }
      },
    };
    registerMessageHandlerFn(mockApp as any);
  });

  test("does NOT spawn a task when assistant_thread message @-mentions another agent", async () => {
    expect(capturedHandler).not.toBeNull();
    const delivery = nextSlackDelivery("evt_prod_hdlr_comention");

    await capturedHandler!({
      event: {
        channel: "D_HANDLER_PROD_TEST",
        ts: delivery.ts,
        text: `<@${DEVIN_USER_ID}> Are you here?`,
        user: "U_HUMAN_HDLR_001",
        assistant_thread: { channel_id: "D_HANDLER_PROD_TEST" },
      },
      body: { event_id: delivery.eventId },
      client: mockClient,
      say: mock(async () => {}),
    });

    expect(createTaskWithSiblingAwarenessSpy).not.toHaveBeenCalled();
  });

  test("DOES spawn a task for assistant_thread plain message with no @-mentions (baseline)", async () => {
    expect(capturedHandler).not.toBeNull();
    const delivery = nextSlackDelivery("evt_prod_hdlr_plain");

    await capturedHandler!({
      event: {
        channel: "D_HANDLER_PROD_TEST",
        ts: delivery.ts,
        text: "What is the current status of all agents?",
        user: "U_HUMAN_HDLR_001",
        assistant_thread: { channel_id: "D_HANDLER_PROD_TEST" },
      },
      body: { event_id: delivery.eventId },
      client: mockClient,
      say: mock(async () => {}),
    });

    expect(createTaskWithSiblingAwarenessSpy).toHaveBeenCalledTimes(1);
  });

  test("does NOT spawn a task when assistant_thread message @-mentions a human (not our bot)", async () => {
    expect(capturedHandler).not.toBeNull();
    const delivery = nextSlackDelivery("evt_prod_hdlr_comention");

    await capturedHandler!({
      event: {
        channel: "D_HANDLER_PROD_TEST",
        ts: delivery.ts,
        text: "<@U037TJB7VHQ> what do you think?",
        user: "U_HUMAN_HDLR_001",
        assistant_thread: { channel_id: "D_HANDLER_PROD_TEST" },
      },
      body: { event_id: delivery.eventId },
      client: mockClient,
      say: mock(async () => {}),
    });

    expect(createTaskWithSiblingAwarenessSpy).not.toHaveBeenCalled();
  });
});
