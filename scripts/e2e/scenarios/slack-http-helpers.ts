import { randomBytes } from "node:crypto";
import type { SlackMock } from "@desplega.ai/slack-mock";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { ScenarioContext } from "../run";
import {
  type CapturedDelivery,
  type CaptureProxy,
  postSigned,
  recordDeliveries,
  startCaptureProxy,
  startHttpSlackMock,
} from "../slack-http";
import { cleanupStack, deleteConfig, putConfig, reloadConfig } from "./platform-helpers";

/** The Chat SDK Slack adapter's webhook, where the HTTP mock posts signed requests. */
export const CHAT_SDK_SLACK_WEBHOOK = "/api/integrations/chat/slack/webhook";

export type ChatSdkSlack = {
  /** The HTTP-mode mock, bound on the port the SUT's `CHAT_SDK_API_URL_OVERRIDES.slack` names. */
  mock: SlackMock;
  signingSecret: string;
  webhookUrl: string;
  /** The scenario context with `slack` swapped to `mock`, for every `slack-helpers.ts` call. */
  ctx: ScenarioContext;
  /** Restores `SLACK_DISABLE`, removes the adapter row, stops the mock. Idempotent. */
  undo: () => Promise<void>;
};

function slackOverridePort(ctx: ScenarioContext): number {
  const overrides = asRecord(JSON.parse(ctx.sutEnv.CHAT_SDK_API_URL_OVERRIDES ?? "{}"));
  return Number(new URL(asString(overrides.slack, "Chat SDK Slack API override")).port);
}

/**
 * Turns the built-in Slack off and the Chat SDK Slack adapter on, wired to a fresh
 * HTTP-mode mock. One config reload does both (the reload tears the built-in app down
 * before the adapter clash check reads `SLACK_DISABLE`). The caller owns `undo`, which
 * must run in a `finally` so a failed scenario cannot leave the run without Socket Mode.
 */
export async function enableChatSdkSlack(ctx: ScenarioContext): Promise<ChatSdkSlack> {
  const signingSecret = randomBytes(16).toString("hex");
  const webhookUrl = `${ctx.baseUrl}${CHAT_SDK_SLACK_WEBHOOK}`;
  const mock = await startHttpSlackMock({
    eventsUrl: webhookUrl,
    signingSecret,
    port: slackOverridePort(ctx),
  });
  const cleanup = cleanupStack(ctx);
  cleanup.add("stop the HTTP Slack mock", () => mock.stop());
  let undone = false;
  const undo = async () => {
    if (undone) return;
    undone = true;
    await cleanup.run();
  };
  try {
    const disable = await putConfig(ctx, { key: "SLACK_DISABLE", value: "true" });
    cleanup.add("restore the built-in Slack", async () => {
      await deleteConfig(ctx, asString(disable.id, "SLACK_DISABLE config id"));
      await reloadConfig(ctx);
      await ctx.slack.waitForConnection(60_000);
    });
    const adapters = await putConfig(ctx, {
      key: "CHAT_SDK_ADAPTERS",
      value: JSON.stringify({
        slack: { botToken: mock.bot.token, signingSecret, mode: "webhook" },
      }),
      isSecret: true,
    });
    cleanup.add("remove the Chat SDK Slack adapter", async () => {
      await deleteConfig(ctx, asString(adapters.id, "CHAT_SDK_ADAPTERS config id"));
      await reloadConfig(ctx);
    });
    await reloadConfig(ctx);
    const running = await pollUntil(async () => {
      const response = await ctx.api("GET", "/api/integrations/chat/status");
      expectStatus(response, [200], "Chat SDK status while enabling the Slack adapter");
      return (
        asRecords(response.json, "adapters").find((adapter) => adapter.name === "slack")?.health ===
        "ok"
      );
    }, 30_000);
    expect(running, "The Chat SDK Slack adapter never reported health ok");
    expect(
      mock.apiCalls("auth.test").length > 0,
      "The Chat SDK Slack adapter never called auth.test on the HTTP mock",
    );
    // The built-in app is off, so the run's Socket mock has no client left.
    expect(
      await pollUntil(() => ctx.slack.connectionCount === 0, 15_000),
      "The built-in Slack socket stayed connected after SLACK_DISABLE",
    );
    return { mock, signingSecret, webhookUrl, ctx: { ...ctx, slack: mock }, undo };
  } catch (error) {
    await undo();
    throw error;
  }
}

export const GENERAL_CHANNEL = "C0GENERAL0";

/** `agent_tasks.key` of a Chat SDK Slack thread in #general. */
export function chatSlackTaskKey(threadTs: string): string {
  return `shared/slack/${GENERAL_CHANNEL.toLowerCase()}/thread:${threadTs}/`;
}

export type ChatTaskRow = { id: string; source: string; status: string; agentId: string | null };

export function chatTasksForThread(ctx: ScenarioContext, threadTs: string): ChatTaskRow[] {
  return ctx.db.query<ChatTaskRow>(
    'SELECT id, source, status, agentId FROM agent_tasks WHERE "key" = ? ORDER BY createdAt',
    [chatSlackTaskKey(threadTs)],
  );
}

/** The one Chat SDK task a Slack thread produced; fails on zero or several. */
export async function waitForChatTask(
  ctx: ScenarioContext,
  threadTs: string,
): Promise<ChatTaskRow> {
  const found = await pollUntil(() => chatTasksForThread(ctx, threadTs).length > 0, 30_000);
  expect(found, `No Chat SDK task for #general thread ${threadTs} within 30 seconds`);
  const tasks = chatTasksForThread(ctx, threadTs);
  expect(tasks.length === 1, `Thread ${threadTs} produced ${tasks.length} Chat SDK tasks, not 1`);
  return tasks[0] as ChatTaskRow;
}

/**
 * Every delivery reached the SUT over HTTP on the first try, and neither mock saw a
 * Socket Mode handshake from the Chat SDK. Also counts the traffic toward route coverage.
 */
export async function expectHttpTransport(
  ctx: ScenarioContext,
  flip: ChatSdkSlack,
  path: string,
): Promise<void> {
  // The bot's own replies come back as events; let the last one settle before judging.
  await flip.mock.flush();
  const deliveries = flip.mock.deliveries();
  expect(deliveries.length > 0, "The HTTP mock recorded no deliveries");
  for (const delivery of deliveries) {
    expect(
      delivery.acked && delivery.attempts === 1,
      `Delivery ${delivery.name} was ${delivery.acked ? "acked" : "not acked"} after ${delivery.attempts} attempt(s)`,
    );
  }
  expect(
    flip.mock.apiCalls("apps.connections.open").length === 0,
    "The Chat SDK Slack adapter opened a Socket Mode connection",
  );
  recordDeliveries(ctx, flip.mock, path);
}

// ─── Native Slack over HTTP (SLACK_MODE=http) ────────────────────────────────

/** The native receiver's one request URL for events, commands and interactivity. */
export const SLACK_EVENTS_PATH = "/api/integrations/slack/events";

export type NativeHttpSlack = {
  /** The HTTP-mode mock the SUT's Web API calls now go to. */
  mock: SlackMock;
  signingSecret: string;
  /** The SUT's receiver, for raw signed requests. */
  eventsUrl: string;
  /** What the mock delivered, with the SUT's real status and response time. */
  proxy: CaptureProxy;
  /** The scenario context with `slack` swapped to `mock`, for every `slack-helpers.ts` call. */
  ctx: ScenarioContext;
  /** Restores Socket Mode, removes the added config rows, stops the mock. Idempotent. */
  undo: () => Promise<void>;
};

function probeBody(): string {
  return JSON.stringify({
    type: "event_callback",
    api_app_id: "A0MOCK0000",
    event_id: `EvPROBE${randomBytes(4).toString("hex").toUpperCase()}`,
    team_id: "T0PROBE000",
    authorizations: [{ team_id: "T0PROBE000", is_enterprise_install: false }],
    event: { type: "app_mention", user: "U0PROBE000", text: "probe", ts: "1.000001" },
  });
}

/**
 * Waits until the receiver takes deliveries. A signed event for another workspace is a 503
 * while the receiver has no workspace identity and a 403 once it has one, so the 403 is the
 * readiness signal. It also runs after an API restart.
 */
export async function waitForNativeReady(
  ctx: ScenarioContext,
  flip: Pick<NativeHttpSlack, "eventsUrl" | "signingSecret">,
): Promise<void> {
  const ready = await pollUntil(async () => {
    const response = await postSigned(ctx, flip.eventsUrl, flip.signingSecret, probeBody()).catch(
      () => undefined,
    );
    return response?.status === 403;
  }, 60_000);
  expect(ready, "The Slack HTTP receiver never answered a foreign-workspace probe with 403");
}

/**
 * Moves the built-in Slack from Socket Mode to the HTTP receiver, wired to a fresh HTTP-mode
 * mock behind a capture proxy. `SLACK_MODE` goes first: the signing secret is the last row, so
 * no intermediate reload starts a socket against the new mock. The caller owns `undo`, which
 * must run in a `finally` so a failed scenario cannot leave the run without Socket Mode.
 */
export async function enableNativeHttp(ctx: ScenarioContext): Promise<NativeHttpSlack> {
  const signingSecret = randomBytes(16).toString("hex");
  const eventsUrl = `${ctx.baseUrl}${SLACK_EVENTS_PATH}`;
  const proxy = startCaptureProxy(eventsUrl);
  const mock = await startHttpSlackMock({ eventsUrl: proxy.url, signingSecret });
  const cleanup = cleanupStack(ctx);
  cleanup.add("stop the HTTP Slack mock", async () => {
    proxy.stop();
    await mock.stop();
  });
  let undone = false;
  const undo = async () => {
    if (undone) return;
    undone = true;
    await cleanup.run();
  };
  try {
    const rows: string[] = [];
    for (const input of [
      { key: "SLACK_MODE", value: "http" },
      { key: "SLACK_API_URL", value: mock.env.SLACK_API_URL as string },
      { key: "SLACK_BOT_TOKEN", value: mock.bot.token, isSecret: true },
      { key: "SLACK_SIGNING_SECRET", value: signingSecret, isSecret: true },
    ]) {
      rows.push(asString((await putConfig(ctx, input)).id, `${input.key} config id`));
    }
    cleanup.add("restore Socket Mode", async () => {
      for (const id of rows) await deleteConfig(ctx, id);
      await reloadConfig(ctx);
      await ctx.slack.waitForConnection(60_000);
    });
    await reloadConfig(ctx);
    await waitForNativeReady(ctx, { eventsUrl, signingSecret });
    // The run's Socket mock has no client left, and the HTTP mock was never asked for one.
    expect(
      await pollUntil(() => ctx.slack.connectionCount === 0, 15_000),
      "The Socket Mode connection stayed open after SLACK_MODE=http",
    );
    expect(
      mock.apiCalls("auth.test").length > 0,
      "The HTTP receiver never called auth.test on the HTTP mock",
    );
    // A mention flow marks its thread for the visuals workflow, which renders the Socket mock.
    return {
      mock,
      signingSecret,
      eventsUrl,
      proxy,
      ctx: { ...ctx, slack: mock, markThread: () => {} },
      undo,
    };
  } catch (error) {
    await undo();
    throw error;
  }
}

/**
 * Every delivery reached the SUT once, was answered 200 inside Slack's 3s budget, and no
 * Socket Mode connection was asked for. Also counts the traffic toward route coverage.
 */
export async function expectNativeTransport(
  ctx: ScenarioContext,
  flip: NativeHttpSlack,
): Promise<void> {
  // The bot's own replies come back as events; let the last one settle before judging.
  await flip.mock.flush();
  const captured = flip.proxy.deliveries;
  expect(captured.length > 0, "The HTTP mock delivered nothing to the SUT");
  for (const delivery of captured) {
    expect(
      delivery.status === 200 && delivery.durationMs < 2_500,
      `A delivery got status ${delivery.status} after ${Math.round(delivery.durationMs)}ms, expected 200 in under 2.5s`,
    );
    ctx.recordHttpCall("POST", SLACK_EVENTS_PATH, delivery.status, delivery.durationMs);
  }
  for (const delivery of flip.mock.deliveries()) {
    expect(
      delivery.acked && delivery.attempts === 1,
      `Delivery ${delivery.name} was ${delivery.acked ? "acked" : "not acked"} after ${delivery.attempts} attempt(s)`,
    );
  }
  expect(
    flip.mock.apiCalls("apps.connections.open").length === 0,
    "The HTTP receiver asked the mock for a Socket Mode connection",
  );
  expect(ctx.slack.connectionCount === 0, "A Socket Mode connection opened during HTTP mode");
}

/** The captured Events API delivery for a message `ts` (`app_mention` first, else `message`). */
export function capturedEventFor(flip: NativeHttpSlack, ts: string): CapturedDelivery {
  const matching = flip.proxy.deliveries.filter((delivery) => {
    try {
      const body = asRecord(JSON.parse(delivery.body));
      return body.type === "event_callback" && asRecord(body.event).ts === ts;
    } catch {
      return false;
    }
  });
  const found =
    matching.find(
      (delivery) => asRecord(asRecord(JSON.parse(delivery.body)).event).type === "app_mention",
    ) ?? matching[0];
  expect(found !== undefined, `The mock never delivered an event for message ${ts}`);
  return found as CapturedDelivery;
}

export type SlackReceipts = { total: number; duplicateDeliveries: number };

/** Receipt totals from the operator diagnostics, to assert that a request stored or deduped. */
export async function slackReceipts(ctx: ScenarioContext): Promise<SlackReceipts> {
  const response = await ctx.api("GET", "/api/slack/inbound/diagnostics");
  expectStatus(response, [200], "read Slack inbound diagnostics");
  const receipts = asRecord(asRecord(response.json).receipts);
  const counts = asRecord(receipts.counts);
  return {
    total: Object.values(counts).reduce<number>((sum, value) => sum + Number(value), 0),
    duplicateDeliveries: Number(receipts.duplicateDeliveries),
  };
}

/** Slack tasks created for a message `ts`, by trigger or thread. */
export function slackTasksForMessage(
  ctx: ScenarioContext,
  ts: string,
): { id: string; status: string }[] {
  return ctx.db.query<{ id: string; status: string }>(
    "SELECT id, status FROM agent_tasks WHERE source = 'slack' AND (slackTriggerMessageTs = ? OR slackThreadTs = ?)",
    [ts, ts],
  );
}
