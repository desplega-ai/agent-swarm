import { expect } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { postSigned } from "../slack-http";
import { registerLead } from "./slack-helpers";
import {
  chatTasksForThread,
  enableChatSdkSlack,
  GENERAL_CHANNEL,
  waitForChatTask,
} from "./slack-http-helpers";

const BUFFER_SETTLE_MS = 2_000;

function mentionBody(ctx: ScenarioContext, botUserId: string, userId: string, ts: string): string {
  const eventId = `Ev${ctx.nonce.slice(0, 9).toUpperCase()}`;
  return JSON.stringify({
    token: "mock-verification-token",
    team_id: "T0MOCK0000",
    api_app_id: "A0MOCK0000",
    type: "event_callback",
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      { team_id: "T0MOCK0000", user_id: botUserId, is_bot: true, is_enterprise_install: false },
    ],
    event: {
      type: "app_mention",
      user: userId,
      text: `<@${botUserId}> signature e2e`,
      ts,
      event_ts: ts,
      channel: GENERAL_CHANNEL,
      team: "T0MOCK0000",
    },
  });
}

export const slackChatSdkSignature: Scenario = {
  name: "slack-chat-sdk-signature",
  order: 689,
  async run(ctx) {
    const flip = await enableChatSdkSlack(ctx);
    let taskId: string | undefined;
    try {
      await registerLead(ctx, "e2e-lead-chat-sdk-signature");
      const slack = flip.mock;
      const ts = `${Math.floor(Date.now() / 1000)}.${ctx.nonce.slice(0, 6).replace(/\D/g, "7").padEnd(6, "7")}`;
      const body = mentionBody(ctx, slack.bot.userId, slack.user("alice").id, ts);
      const post = (options: Parameters<typeof postSigned>[4], payload = body) =>
        postSigned(ctx, flip.webhookUrl, flip.signingSecret, payload, options);

      for (const [label, options] of [
        ["unsigned", { unsigned: true }],
        ["forged signature", { signWith: "not-the-signing-secret" }],
        ["stale timestamp", { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 }],
      ] as const) {
        const response = await post(options);
        expect(response.status === 401, `${label} request got ${response.status}, expected 401`);
      }
      await Bun.sleep(BUFFER_SETTLE_MS);
      expect(
        chatTasksForThread(ctx, ts).length === 0,
        "A rejected request created a Chat SDK task",
      );

      const accepted = await post({});
      expect(accepted.status === 200, `Signed event got ${accepted.status}, expected 200`);
      const task = await waitForChatTask(ctx, ts);
      taskId = task.id;

      // Slack redelivers an event it did not see acked, with the same event_id and retry
      // headers; a replay without them is the same message arriving twice. Either way the
      // adapter or the SDK's message-id dedupe must drop it.
      for (const [label, headers] of [
        ["retried", { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" }],
        ["replayed", {}],
      ] as const) {
        const response = await post({ headers });
        expect(response.status === 200, `${label} event got ${response.status}, expected 200`);
        await Bun.sleep(BUFFER_SETTLE_MS);
        const tasks = chatTasksForThread(ctx, ts);
        expect(
          tasks.length === 1 && tasks[0]?.id === task.id,
          `A ${label} delivery left ${tasks.length} Chat SDK tasks for the thread, expected the original only`,
        );
      }
    } finally {
      // No pending task left in the pool for whatever runs next.
      if (taskId) await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} });
      await flip.undo();
    }
  },
};
