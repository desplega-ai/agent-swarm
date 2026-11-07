/**
 * Native Slack HTTP receiver (SLACK_MODE=http): the signature, timestamp and
 * workspace gates, url_verification, durable event admission with retry dedupe,
 * the live command path, the route's mode and body-size gates, and that HTTP
 * mode never builds a socket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { closeDb, getDbClient, initDb } from "../be/db";
import { getSlackInboundReceiptByKey } from "../be/db-queries/slack-inbound";
import { handleSlackEvents } from "../http/slack-events";
import { getSlackHttpReceiver, startSlackApp, stopSlackApp } from "../slack/app";
import { SwarmHttpReceiver } from "../slack/http-receiver";
import {
  ignoreSelfAsIgnored,
  resetSlackInboundCountersForTests,
  runAdmittedSlackDelivery,
} from "../slack/inbound-dispatch";
import {
  getSlackWorkspaceIdentity,
  resetSlackWorkspaceGuardForTests,
  setSlackWorkspaceIdentitySource,
} from "../slack/workspace-guard";
import { listenOnFreePort } from "./test-net";

const SECRET = "synthetic-signing-secret";
const NOW_MS = Date.UTC(2026, 10, 7, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function sign(body: string, timestampSec: number = NOW_SEC, secret: string = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:${body}`).digest("hex")}`;
}

function eventBody(eventId: string, team = "T_TEST"): string {
  return JSON.stringify({
    type: "event_callback",
    api_app_id: "A_TEST",
    event_id: eventId,
    team_id: team,
    authorizations: [{ team_id: team, enterprise_id: null, is_enterprise_install: false }],
    event: { type: "app_mention", user: "U1", text: "<@UBOT> hi", ts: "1950000000.000001" },
  });
}

function signed(body: string, extra: Partial<Parameters<SwarmHttpReceiver["handle"]>[0]> = {}) {
  return {
    rawBody: Buffer.from(body),
    signature: sign(body),
    timestamp: String(NOW_SEC),
    contentType: "application/json",
    retryNum: undefined,
    retryReason: undefined,
    signingSecret: SECRET,
    ...extra,
  };
}

async function useIdentity(identity: boolean): Promise<void> {
  resetSlackWorkspaceGuardForTests();
  if (!identity) return;
  setSlackWorkspaceIdentitySource(async () => ({
    teamId: "T_TEST",
    enterpriseId: null,
    isEnterpriseInstall: false,
  }));
  await getSlackWorkspaceIdentity();
}

let receiver: SwarmHttpReceiver;
let onAdmitted: ReturnType<typeof mock>;
let processEvent: ReturnType<typeof mock>;

beforeAll(() => {
  initDb(":memory:");
});

afterAll(() => {
  resetSlackWorkspaceGuardForTests();
  closeDb();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM slack_inbound_receipts");
  resetSlackInboundCountersForTests();
  await useIdentity(true);
  onAdmitted = mock(() => {});
  processEvent = mock(async () => {});
  receiver = new SwarmHttpReceiver(onAdmitted as () => void);
  receiver.init({ processEvent } as never);
  receiver.markReady();
});

describe("signature and timestamp gates", () => {
  test("missing signature headers are refused before any parsing", async () => {
    const body = eventBody("Ev_1");
    expect((await receiver.handle(signed(body, { signature: undefined }), NOW_MS)).status).toBe(
      401,
    );
    expect((await receiver.handle(signed(body, { timestamp: undefined }), NOW_MS)).status).toBe(
      401,
    );
    expect((await receiver.handle(signed(body, { timestamp: "abc" }), NOW_MS)).status).toBe(401);
  });

  test("a wrong secret, a tampered body and a malformed signature are refused", async () => {
    const body = eventBody("Ev_2");
    const wrongSecret = signed(body, { signature: sign(body, NOW_SEC, "other-secret") });
    expect((await receiver.handle(wrongSecret, NOW_MS)).status).toBe(401);
    const tampered = signed(body, { rawBody: Buffer.from(`${body} `) });
    expect((await receiver.handle(tampered, NOW_MS)).status).toBe(401);
    expect((await receiver.handle(signed(body, { signature: "garbage" }), NOW_MS)).status).toBe(
      401,
    );
    expect(await getSlackInboundReceiptByKey("event:A_TEST:Ev_2")).toBeNull();
  });

  test("a stale or future timestamp is refused even with a valid signature", async () => {
    const body = eventBody("Ev_3");
    const stale = NOW_SEC - 6 * 60;
    const future = NOW_SEC + 6 * 60;
    for (const ts of [stale, future]) {
      const result = await receiver.handle(
        signed(body, { signature: sign(body, ts), timestamp: String(ts) }),
        NOW_MS,
      );
      expect(result.status).toBe(401);
    }
    const edge = NOW_SEC - 4 * 60;
    const ok = await receiver.handle(
      signed(body, { signature: sign(body, edge), timestamp: String(edge) }),
      NOW_MS,
    );
    expect(ok.status).toBe(200);
  });

  test("the error body carries no payload, secret or verifier detail", async () => {
    const result = await receiver.handle(
      signed(eventBody("Ev_4"), { signature: "v0=bad" }),
      NOW_MS,
    );
    expect(result.body).toBe(JSON.stringify({ error: "invalid_signature" }));
  });
});

describe("body parsing", () => {
  test("url_verification answers the challenge, with no workspace identity yet", async () => {
    await useIdentity(false);
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const result = await receiver.handle(signed(body), NOW_MS);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ challenge: "abc123" });
  });

  test("url_verification still needs a valid signature", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const result = await receiver.handle(signed(body, { signature: "v0=bad" }), NOW_MS);
    expect(result.status).toBe(401);
  });

  test("malformed JSON and unsupported content types are 400 after a valid signature", async () => {
    expect((await receiver.handle(signed("{not json"), NOW_MS)).status).toBe(400);
    expect((await receiver.handle(signed("[1]"), NOW_MS)).status).toBe(400);
    expect(
      (await receiver.handle(signed(eventBody("Ev_5"), { contentType: "text/plain" }), NOW_MS))
        .status,
    ).toBe(400);
    const form = "payload=%7Bnot-json";
    expect(
      (
        await receiver.handle(
          signed(form, { signature: sign(form), contentType: "application/x-www-form-urlencoded" }),
          NOW_MS,
        )
      ).status,
    ).toBe(400);
  });
});

describe("workspace gate", () => {
  test("a delivery for another workspace is 403 and stores nothing", async () => {
    const body = eventBody("Ev_FOREIGN", "T_OTHER");
    const result = await receiver.handle(signed(body), NOW_MS);
    expect(result.status).toBe(403);
    expect(await getSlackInboundReceiptByKey("event:A_TEST:Ev_FOREIGN")).toBeNull();
    expect(onAdmitted).not.toHaveBeenCalled();
  });

  test("an unresolved identity is a retryable 503", async () => {
    await useIdentity(false);
    const result = await receiver.handle(signed(eventBody("Ev_NOID")), NOW_MS);
    expect(result.status).toBe(503);
    expect(result.headers?.["Retry-After"]).toBe("5");
    expect(await getSlackInboundReceiptByKey("event:A_TEST:Ev_NOID")).toBeNull();
  });

  test("a receiver that is not ready is a retryable 503", async () => {
    const cold = new SwarmHttpReceiver(() => {});
    cold.init({ processEvent } as never);
    const result = await cold.handle(signed(eventBody("Ev_COLD")), NOW_MS);
    expect(result.status).toBe(503);
  });
});

describe("events", () => {
  test("an event is stored before the 200 and a retry never admits it twice", async () => {
    const body = eventBody("Ev_ONCE");
    const first = await receiver.handle(signed(body), NOW_MS);
    expect(first.status).toBe(200);
    const stored = await getSlackInboundReceiptByKey("event:A_TEST:Ev_ONCE");
    expect(stored?.transport).toBe("http");
    expect(stored?.state).toBe("pending");
    expect(onAdmitted).toHaveBeenCalledTimes(1);

    const retry = await receiver.handle(
      signed(body, { retryNum: "1", retryReason: "http_timeout" }),
      NOW_MS,
    );
    expect(retry.status).toBe(200);
    expect(onAdmitted).toHaveBeenCalledTimes(1);
    const after = await getSlackInboundReceiptByKey("event:A_TEST:Ev_ONCE");
    expect(after?.id).toBe(stored?.id);
    expect(after?.duplicateCount).toBe(1);
    // The receiver never runs Bolt for an event: the durable drain does.
    expect(processEvent).not.toHaveBeenCalled();
  });

  test("an event without an event_id is a 400", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      authorizations: [{ team_id: "T_TEST", enterprise_id: null, is_enterprise_install: false }],
    });
    expect((await receiver.handle(signed(body), NOW_MS)).status).toBe(400);
  });

  test("a control envelope with no work is acknowledged without a receipt", async () => {
    const body = JSON.stringify({ type: "app_rate_limited", api_app_id: "A_TEST" });
    expect((await receiver.handle(signed(body), NOW_MS)).status).toBe(200);
    expect(onAdmitted).not.toHaveBeenCalled();
  });

  test("an order-dependent event runs inline once and its retry is dropped", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_TEST",
      event_id: "Ev_CTX",
      authorizations: [{ team_id: "T_TEST", enterprise_id: null, is_enterprise_install: false }],
      event: { type: "assistant_thread_context_changed" },
    });
    expect((await receiver.handle(signed(body), NOW_MS)).status).toBe(200);
    expect((await receiver.handle(signed(body, { retryNum: "1" }), NOW_MS)).status).toBe(200);
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(onAdmitted).not.toHaveBeenCalled();
  });
});

describe("commands and interactivity", () => {
  function form(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
  }
  const formHeaders = (body: string) => ({
    signature: sign(body),
    contentType: "application/x-www-form-urlencoded",
  });

  test("a slash command runs through Bolt and returns the handler's ack", async () => {
    const body = form({ command: "/agent-swarm-help", team_id: "T_TEST", user_id: "U1" });
    processEvent.mockImplementation((async ({ ack }: { ack: (r?: unknown) => Promise<void> }) => {
      await ack({ response_type: "ephemeral", text: "help" });
    }) as never);
    const result = await receiver.handle(signed(body, formHeaders(body)), NOW_MS);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ response_type: "ephemeral", text: "help" });
    expect(result.contentType).toBe("application/json");
    expect(processEvent.mock.calls[0]?.[0]).toMatchObject({
      body: { command: "/agent-swarm-help", team_id: "T_TEST" },
    });
  });

  test("an interactive payload is parsed from the form `payload` field", async () => {
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T_TEST" },
      actions: [{ action_id: "cancel_task" }],
    });
    const body = form({ payload });
    processEvent.mockImplementation((async ({ ack }: { ack: () => Promise<void> }) => {
      await ack();
    }) as never);
    const result = await receiver.handle(signed(body, formHeaders(body)), NOW_MS);
    expect(result).toEqual({ status: 200 });
    expect(processEvent.mock.calls[0]?.[0]).toMatchObject({ body: { type: "block_actions" } });
  });

  test("a command from another workspace never reaches Bolt", async () => {
    const body = form({ command: "/agent-swarm-help", team_id: "T_OTHER" });
    const result = await receiver.handle(signed(body, formHeaders(body)), NOW_MS);
    expect(result.status).toBe(403);
    expect(processEvent).not.toHaveBeenCalled();
  });

  test("a handler that never acks gets an empty 200 at the ack deadline", async () => {
    const body = form({ command: "/agent-swarm-help", team_id: "T_TEST" });
    processEvent.mockImplementation((() => new Promise(() => {})) as never);
    const startedAt = Date.now();
    const result = await receiver.handle(signed(body, formHeaders(body)), NOW_MS);
    expect(result).toEqual({ status: 200 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("ssl_check is acknowledged after the signature check", async () => {
    const body = form({ ssl_check: "1", token: "x" });
    expect((await receiver.handle(signed(body, formHeaders(body)), NOW_MS)).status).toBe(200);
  });
});

describe("route and lifecycle", () => {
  const previous = {
    SLACK_MODE: process.env.SLACK_MODE,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_API_URL: process.env.SLACK_API_URL,
    SLACK_DISABLE: process.env.SLACK_DISABLE,
  };

  afterEach(async () => {
    await stopSlackApp();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function withRoute<T>(fn: (url: string) => Promise<T>): Promise<T> {
    const server = createServer((req, res) => {
      const segments = (req.url ?? "").split("?")[0]?.split("/").filter(Boolean) ?? [];
      void handleSlackEvents(req, res, segments).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    const port = await listenOnFreePort(server);
    try {
      return await fn(`http://127.0.0.1:${port}/api/integrations/slack/events`);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  test("the route is closed under Socket Mode and when Slack is disabled", async () => {
    process.env.SLACK_MODE = "socket";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_DISABLE = "false";
    await withRoute(async (url) => {
      const res = await fetch(url, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
      process.env.SLACK_MODE = "http";
      process.env.SLACK_SIGNING_SECRET = SECRET;
      process.env.SLACK_DISABLE = "true";
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404);
    });
  });

  test("an over-cap body is 413 before it is buffered", async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_DISABLE = "false";
    const slack = await startSlackMock(false);
    try {
      Object.assign(process.env, slack.mock.env);
      process.env.SLACK_MODE = "http";
      expect(await startSlackApp()).toBe(true);
      await withRoute(async (url) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(1024 * 1024 + 1),
        });
        expect(res.status).toBe(413);
      });
    } finally {
      await stopSlackApp();
      await stopSlackMock(slack, false);
    }
  });

  test("SLACK_MODE=http starts a receiver and never builds a socket, even with an app token", async () => {
    const slack = await startSlackMock(false);
    try {
      Object.assign(process.env, slack.mock.env);
      process.env.SLACK_MODE = "http";
      process.env.SLACK_SIGNING_SECRET = SECRET;
      process.env.SLACK_DISABLE = "false";
      expect(process.env.SLACK_APP_TOKEN).toBeTruthy();

      expect(await startSlackApp()).toBe(true);
      expect(getSlackHttpReceiver()).not.toBeNull();
      expect(slack.mock.apiCalls("apps.connections.open")).toHaveLength(0);
      expect(slack.mock.connectionCount).toBe(0);

      await withRoute(async (url) => {
        const body = JSON.stringify({ type: "url_verification", challenge: "live-challenge" });
        const ts = Math.floor(Date.now() / 1000);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": sign(body, ts),
            "x-slack-request-timestamp": String(ts),
          },
          body,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ challenge: "live-challenge" });

        const bad = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=bad",
            "x-slack-request-timestamp": String(ts),
          },
          body,
        });
        expect(bad.status).toBe(401);
      });

      await stopSlackApp();
      expect(getSlackHttpReceiver()).toBeNull();
    } finally {
      await stopSlackApp();
      await stopSlackMock(slack, false);
    }
  }, 20_000);
});

describe("ignoreSelfAsIgnored", () => {
  async function run(event: Record<string, unknown>) {
    const next = mock(async () => {});
    const outcome = await runAdmittedSlackDelivery("http", () =>
      ignoreSelfAsIgnored({
        context: { botId: "B_SELF", botUserId: "U_SELF" },
        event,
        message: event,
        next,
      } as never),
    );
    return { outcome, next };
  }

  test("a bot-authored event is ignored, not left undispatched", async () => {
    const { outcome, next } = await run({
      type: "message",
      subtype: "bot_message",
      bot_id: "B_SELF",
    });
    expect(next).not.toHaveBeenCalled();
    expect(outcome).toEqual({ state: "ignored", code: "self_event" });
  });

  test("anyone else's event goes on to the listeners", async () => {
    const { outcome, next } = await run({ type: "message", user: "U_OTHER" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe("processed");
  });
});
