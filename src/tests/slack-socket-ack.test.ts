/**
 * A Socket Mode ack that fails because the client is not ready must not lose
 * the event: Bolt acks before it runs listeners and drops the event when the
 * ack throws. Drives a real Bolt App through a real SocketModeReceiver.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { createAssistant } from "../slack/assistant";
import { _resetForTests as resetEventDedup, wasEventSeen } from "../slack/event-dedup";
import {
  getSlackInboundDiagnostics,
  resetSlackInboundCountersForTests,
  slackInboundOutcomeMiddleware,
} from "../slack/inbound-dispatch";
import { tolerateSocketNotReadyAcks } from "../slack/socket-ack";

type SocketClient = SocketModeReceiver["client"];

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
async function deliver(client: SocketClient, eventId: string, retryNum?: number): Promise<void> {
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
      event: { type: "message", channel: "C_TEST", ts: "1.000001", user: "U_HUMAN", text: "hi" },
    },
    retry_num: retryNum,
    retry_reason: retryNum ? "timeout" : undefined,
  });
  // The receiver's listener is async; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  beforeEach(() => {
    resetEventDedup();
    resetSlackInboundCountersForTests();
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
    expect(outcomes.socket.processed).toBe(2);
    expect(outcomes.http.ackNotReady).toBe(0);
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

describe("assistant thread_started redelivery", () => {
  beforeEach(() => {
    resetEventDedup();
  });

  test("a redelivery after a tolerated ack failure does not greet twice", async () => {
    const prev = process.env.SLACK_RENDER_V2;
    process.env.SLACK_RENDER_V2 = "false";
    try {
      const threadStarted = (
        createAssistant() as never as {
          threadStarted: Array<(args: Record<string, unknown>) => Promise<void>>;
        }
      ).threadStarted[0]!;
      let greetings = 0;
      const deliverStart = () =>
        threadStarted({
          event: { assistant_thread: { channel_id: "D_TEST", thread_ts: "1.000001" } },
          body: { event_id: "Ev_THREAD_STARTED" },
          client: {},
          say: async () => {
            greetings++;
          },
          setSuggestedPrompts: async () => {},
          saveThreadContext: async () => {},
        });

      await deliverStart();
      await deliverStart();
      expect(greetings).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.SLACK_RENDER_V2;
      else process.env.SLACK_RENDER_V2 = prev;
    }
  });
});
