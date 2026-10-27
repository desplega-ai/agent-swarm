/**
 * A Socket Mode ack that fails because the client is not ready must not lose
 * the event: Bolt acks before it runs listeners and drops the event when the
 * ack throws. Drives a real Bolt App through a real SocketModeReceiver.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { closeDb, getDbClient, initDb } from "../be/db";
import { createAssistant } from "../slack/assistant";
import { _resetForTests as resetEventDedup, wasEventSeen } from "../slack/event-dedup";
import {
  getSlackInboundDiagnostics,
  resetSlackInboundCountersForTests,
  slackInboundOutcomeMiddleware,
} from "../slack/inbound-dispatch";
import { tolerateSocketNotReadyAcks } from "../slack/socket-ack";

type SocketClient = SocketModeReceiver["client"];

const TEST_DB_PATH = "./test-slack-socket-ack.sqlite";
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};
let savedMigrationTemplate: Uint8Array | undefined;
const previousRenderV2 = process.env.SLACK_RENDER_V2;

function removeTestDb(): void {
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      // The SQLite sidecars are not always created.
    }
  }
}

beforeAll(() => {
  closeDb();
  savedMigrationTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  removeTestDb();
  initDb(TEST_DB_PATH);
  process.env.SLACK_RENDER_V2 = "false";
});

afterAll(() => {
  if (previousRenderV2 === undefined) delete process.env.SLACK_RENDER_V2;
  else process.env.SLACK_RENDER_V2 = previousRenderV2;
  closeDb();
  removeTestDb();
  testGlobals.__testMigrationTemplate = savedMigrationTemplate;
});

/** The real client `send`, used by the ack the client builds for each envelope. */
function clientSend(
  client: SocketClient,
): (id: string, body?: Record<string, unknown>) => Promise<void> {
  const send = (
    client as unknown as { send: (id: string, body?: Record<string, unknown>) => Promise<void> }
  ).send;
  return send.bind(client);
}

function setSocket(client: SocketClient, socket: { isActive: () => boolean } | undefined): void {
  (client as unknown as { websocket?: { isActive: () => boolean } }).websocket = socket;
}

function buildApp(): { client: SocketClient; runs: string[]; errors: unknown[] } {
  const receiver = new SocketModeReceiver({ appToken: "xapp-test", logLevel: LogLevel.ERROR });
  tolerateSocketNotReadyAcks(receiver.client);
  const app = new App({
    receiver,
    socketMode: true,
    logLevel: LogLevel.ERROR,
    authorize: async () => ({ botToken: "xoxb-test", botId: "B_TEST", botUserId: "U_BOT" }),
  });
  const runs: string[] = [];
  const errors: unknown[] = [];
  app.error(async (error) => {
    errors.push(error);
  });
  app.use(slackInboundOutcomeMiddleware());
  // Mirrors the dedup at the top of the message handler (src/slack/handlers.ts).
  app.event("message", async ({ body }) => {
    if (wasEventSeen(body.event_id)) return;
    runs.push(body.event_id);
  });
  // Mirrors actions.ts: acks first, then does the work.
  app.view("follow_up_submit", async ({ ack, body }) => {
    await ack();
    runs.push(`view:${body.view.id}`);
  });
  return { client: receiver.client, runs, errors };
}

/** Deliver an envelope the way SocketModeClient does: emit `slack_event` with its ack. */
async function deliverEvent(
  client: SocketClient,
  eventId: string,
  event: Record<string, unknown>,
  retryNum?: number,
): Promise<void> {
  const send = clientSend(client);
  const envelopeId = `env-${eventId}-${retryNum ?? 0}`;
  client.emit("slack_event", {
    ack: (response?: Record<string, unknown>) => send(envelopeId, response),
    envelope_id: envelopeId,
    type: "events_api",
    body: {
      type: "event_callback",
      team_id: "T_TEST",
      api_app_id: "A_TEST",
      event_id: eventId,
      event,
    },
    retry_num: retryNum,
    retry_reason: retryNum ? "timeout" : undefined,
  });
  // The receiver's listener is async; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function deliver(client: SocketClient, eventId: string, retryNum?: number): Promise<void> {
  return deliverEvent(
    client,
    eventId,
    { type: "message", channel: "C_TEST", ts: "1.000001", user: "U_HUMAN", text: "hi" },
    retryNum,
  );
}

/** Deliver an interactive modal submission the way SocketModeClient does. */
async function deliverViewSubmission(client: SocketClient, viewId: string): Promise<void> {
  const send = clientSend(client);
  const envelopeId = `env-${viewId}`;
  client.emit("slack_event", {
    ack: (response?: Record<string, unknown>) => send(envelopeId, response),
    envelope_id: envelopeId,
    type: "interactive",
    body: {
      type: "view_submission",
      team: { id: "T_TEST" },
      user: { id: "U_HUMAN" },
      api_app_id: "A_TEST",
      view: {
        id: viewId,
        callback_id: "follow_up_submit",
        private_metadata: "t",
        state: { values: {} },
      },
    },
    accepts_response_payload: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("Socket Mode ack failures", () => {
  beforeEach(async () => {
    resetEventDedup();
    resetSlackInboundCountersForTests();
    await getDbClient().run("DELETE FROM slack_inbound_receipts");
  });

  test("a not-ready ack still runs the listener once, and the retry is dropped", async () => {
    const { client, runs } = buildApp();
    setSocket(client, { isActive: () => false });

    await deliver(client, "Ev_NOT_READY");
    expect(runs).toEqual(["Ev_NOT_READY"]);

    // Slack redelivers the unacked event with the same event_id once the socket is back.
    setSocket(client, undefined);
    (client as unknown as { send: () => Promise<void> }).send = async () => {};
    await deliver(client, "Ev_NOT_READY", 1);
    expect(runs).toEqual(["Ev_NOT_READY"]);

    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket.ackNotReady).toBe(1);
    expect(outcomes.socket.processed).toBe(1); // the retry never reaches Bolt
    expect(outcomes.http.ackNotReady).toBe(0);
  });

  test("a retry after a restart is still dropped, because the key was persisted", async () => {
    const first = buildApp();
    setSocket(first.client, { isActive: () => false });
    await deliver(first.client, "Ev_RESTART");
    expect(first.runs).toEqual(["Ev_RESTART"]);

    const stored = await getDbClient().get<{ state: string; outcome_code: string }>(
      "SELECT state, outcome_code FROM slack_inbound_receipts WHERE event_id = ?",
      ["Ev_RESTART"],
    );
    expect(stored).toMatchObject({ state: "processed", outcome_code: "ack_not_ready" });

    // Restart: the in-memory dedup cache and the whole Bolt app are rebuilt.
    resetEventDedup();
    const second = buildApp();
    (second.client as unknown as { send: () => Promise<void> }).send = async () => {};
    await deliver(second.client, "Ev_RESTART", 1);
    expect(second.runs).toEqual([]);
    expect(second.errors).toEqual([]);

    const row = await getDbClient().get<{ duplicate_count: number }>(
      "SELECT duplicate_count FROM slack_inbound_receipts WHERE event_id = ?",
      ["Ev_RESTART"],
    );
    expect(row?.duplicate_count).toBe(1);
  });

  test("a retry whose original was never recorded still runs", async () => {
    const { client, runs } = buildApp();
    (client as unknown as { send: () => Promise<void> }).send = async () => {};
    await deliver(client, "Ev_NEVER_SEEN", 1);
    expect(runs).toEqual(["Ev_NEVER_SEEN"]);
  });

  test("any other ack error still drops the event", async () => {
    const { client, runs } = buildApp();
    // No socket at all: the client rejects with "not connected", not "not ready".
    setSocket(client, undefined);

    await deliver(client, "Ev_NOT_CONNECTED");
    expect(runs).toEqual([]);
    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket.ackNotReady).toBe(0);
  });

  test("a failed modal submission ack is not swallowed, so the handler does no work", async () => {
    const { client, runs, errors } = buildApp();
    setSocket(client, { isActive: () => false });

    await deliverViewSubmission(client, "V_FAILED");
    expect(runs).toEqual([]);
    expect(errors.length).toBe(1);
    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket.ackNotReady).toBe(0);
  });

  test("a healthy modal submission still runs", async () => {
    const { client, runs } = buildApp();
    (client as unknown as { send: () => Promise<void> }).send = async () => {};

    await deliverViewSubmission(client, "V_OK");
    expect(runs).toEqual(["view:V_OK"]);
  });
});

/** A Slack Web API that accepts every call and records the methods it served. */
function startFakeSlackApi(): { url: string; calls: string[]; stop: () => void } {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      calls.push(new URL(req.url).pathname.replace(/^\/api\//, ""));
      return Response.json({ ok: true, ts: "2.000001", channel: "D_TEST" });
    },
  });
  return { url: `http://localhost:${server.port}/api/`, calls, stop: () => server.stop(true) };
}

describe("assistant events through Bolt", () => {
  let api: ReturnType<typeof startFakeSlackApi>;
  let saved: string[];

  beforeEach(async () => {
    resetEventDedup();
    await getDbClient().run("DELETE FROM slack_inbound_receipts");
    api = startFakeSlackApi();
    saved = [];
  });

  function buildAssistantApp(): SocketClient {
    const receiver = new SocketModeReceiver({ appToken: "xapp-test", logLevel: LogLevel.ERROR });
    tolerateSocketNotReadyAcks(receiver.client);
    const app = new App({
      receiver,
      socketMode: true,
      logLevel: LogLevel.ERROR,
      clientOptions: { slackApiUrl: api.url },
      authorize: async () => ({ botToken: "xoxb-test", botId: "B_TEST", botUserId: "U_BOT" }),
    });
    app.use(slackInboundOutcomeMiddleware());
    // Bolt's default store reads and writes thread metadata through the Slack API.
    app.assistant(
      createAssistant({
        threadContextStore: {
          get: async () => ({ channel_id: saved.at(-1) }),
          save: async (args) => {
            const payload = args.payload as {
              assistant_thread: { context: { channel_id: string } };
            };
            saved.push(payload.assistant_thread.context.channel_id);
          },
        },
      }),
    );
    return receiver.client;
  }

  const threadStarted = {
    type: "assistant_thread_started",
    assistant_thread: {
      user_id: "U_HUMAN",
      channel_id: "D_TEST",
      thread_ts: "1.000001",
      context: { channel_id: "C_A", team_id: "T_TEST" },
    },
    event_ts: "1.000002",
  };

  const contextChanged = (channelId: string) => ({
    type: "assistant_thread_context_changed",
    assistant_thread: {
      user_id: "U_HUMAN",
      channel_id: "D_TEST",
      thread_ts: "1.000001",
      context: { channel_id: channelId, team_id: "T_TEST" },
    },
    event_ts: "1.000003",
  });

  test("a redelivered thread_started after a failed ack does not greet twice", async () => {
    const client = buildAssistantApp();
    try {
      setSocket(client, { isActive: () => false });
      await deliverEvent(client, "Ev_STARTED", threadStarted);
      expect(api.calls.filter((c) => c === "chat.postMessage")).toHaveLength(1);

      setSocket(client, undefined);
      (client as unknown as { send: () => Promise<void> }).send = async () => {};
      await deliverEvent(client, "Ev_STARTED", threadStarted, 1);
      expect(api.calls.filter((c) => c === "chat.postMessage")).toHaveLength(1);
    } finally {
      api.stop();
    }
  });

  test("a stale context_changed redelivery does not overwrite newer context", async () => {
    const client = buildAssistantApp();
    try {
      // A runs without an ack, B arrives and acks, then Slack redelivers A.
      setSocket(client, { isActive: () => false });
      await deliverEvent(client, "Ev_CTX_A", contextChanged("C_A"));
      setSocket(client, undefined);
      (client as unknown as { send: () => Promise<void> }).send = async () => {};
      await deliverEvent(client, "Ev_CTX_B", contextChanged("C_B"));
      await deliverEvent(client, "Ev_CTX_A", contextChanged("C_A"), 1);
      expect(saved).toEqual(["C_A", "C_B"]);
    } finally {
      api.stop();
    }
  });

  test("a stale context_changed redelivery is dropped by the listener when it was not stored", async () => {
    const client = buildAssistantApp();
    try {
      (client as unknown as { send: () => Promise<void> }).send = async () => {};
      await deliverEvent(client, "Ev_CTX_A", contextChanged("C_A"));
      await deliverEvent(client, "Ev_CTX_B", contextChanged("C_B"));
      // No retry_num, so the stored-key check is skipped: the listener's own dedup must hold.
      await deliverEvent(client, "Ev_CTX_A", contextChanged("C_A"));
      expect(saved).toEqual(["C_A", "C_B"]);
    } finally {
      api.stop();
    }
  });
});
