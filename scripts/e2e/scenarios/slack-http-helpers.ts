import { randomBytes } from "node:crypto";
import type { SlackMock } from "@desplega.ai/slack-mock";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { ScenarioContext } from "../run";
import { recordDeliveries, startHttpSlackMock } from "../slack-http";
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
