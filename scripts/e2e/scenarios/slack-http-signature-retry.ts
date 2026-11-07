import { HttpDelivery } from "@desplega.ai/slack-mock";
import { expect } from "../http";
import type { Scenario } from "../run";
import { postSigned } from "../slack-http";
import { ask, claim, findSlackTask, finish, registerLead, waitForEyes } from "./slack-helpers";
import {
  capturedEventFor,
  enableNativeHttp,
  expectNativeTransport,
  slackReceipts,
  slackTasksForMessage,
} from "./slack-http-helpers";

const SETTLE_MS = 2_000;

function eventBody(nonce: string, team: string, ts: string): string {
  return JSON.stringify({
    token: "mock-verification-token",
    team_id: team,
    api_app_id: "A0MOCK0000",
    type: "event_callback",
    event_id: `Ev${nonce.slice(0, 9).toUpperCase()}`,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: team, is_bot: true, is_enterprise_install: false }],
    event: {
      type: "app_mention",
      user: "U0FORGED00",
      text: "<@U0BOT00000> forged",
      ts,
      event_ts: ts,
      channel: "C0GENERAL0",
      team,
    },
  });
}

/**
 * The receiver's gates over the wire: forged, stale, future-dated and unsigned requests are
 * 401 and store nothing, a signed event for another workspace is 403, and Slack's redelivery
 * of an accepted event (retry headers or not) is acked without a second task.
 */
export const slackHttpSignatureRetry: Scenario = {
  name: "slack-http-signature-retry",
  order: 179,
  async run(ctx) {
    const flip = await enableNativeHttp(ctx);
    let taskId: string | undefined;
    try {
      const leadId = await registerLead(flip.ctx, "e2e-lead-http-signature");
      const post = (body: string, options: Parameters<typeof postSigned>[4] = {}) =>
        postSigned(ctx, flip.eventsUrl, flip.signingSecret, body, options);

      expect(
        await new HttpDelivery({
          eventsUrl: flip.eventsUrl,
          signingSecret: flip.signingSecret,
        }).verifyUrl(),
        "The receiver did not echo the url_verification challenge",
      );

      const before = await slackReceipts(ctx);
      const ts = `${Math.floor(Date.now() / 1000)}.${ctx.nonce.slice(0, 6).replace(/\D/g, "7").padEnd(6, "7")}`;
      const forged = eventBody(ctx.nonce, flip.mock.team.id, ts);
      const now = Math.floor(Date.now() / 1000);
      for (const [label, options] of [
        ["unsigned", { unsigned: true }],
        ["forged signature", { signWith: "not-the-signing-secret" }],
        ["stale timestamp", { timestamp: now - 10 * 60 }],
        ["future timestamp", { timestamp: now + 10 * 60 }],
      ] as const) {
        const response = await post(forged, options);
        expect(response.status === 401, `${label} request got ${response.status}, expected 401`);
      }
      const foreign = await post(eventBody(ctx.nonce, "T0OTHER000", ts));
      expect(foreign.status === 403, `Foreign-workspace event got ${foreign.status}, expected 403`);
      const malformed = await post("{not json");
      expect(malformed.status === 400, `Malformed body got ${malformed.status}, expected 400`);
      await Bun.sleep(SETTLE_MS);
      expect(
        (await slackReceipts(ctx)).total === before.total &&
          slackTasksForMessage(ctx, ts).length === 0,
        "A refused request stored a receipt or created a task",
      );

      // A real mention: the receiver stores the event, the drain creates the task.
      const message = await ask(flip.ctx, "say hello once");
      await waitForEyes(flip.ctx, message.ts);
      const task = await findSlackTask(flip.ctx, message.ts);
      taskId = String(task.id);
      // Earlier leads in the run may hold the task, so claim as whoever it went to.
      const assignedId = typeof task.agentId === "string" ? task.agentId : leadId;
      expect(
        slackTasksForMessage(ctx, message.ts).length === 1,
        `Mention ${message.ts} produced ${slackTasksForMessage(ctx, message.ts).length} tasks, not 1`,
      );

      // Slack redelivers an event it did not see acked, with the same event_id and retry
      // headers. A replay without them is the same event arriving twice. Both are acked
      // as duplicates and never reach Bolt.
      const original = capturedEventFor(flip, message.ts);
      const duplicatesBefore = (await slackReceipts(ctx)).duplicateDeliveries;
      for (const [label, headers] of [
        ["retried", { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" }],
        ["replayed", {}],
      ] as const) {
        const response = await post(original.body, { headers });
        expect(response.status === 200, `${label} event got ${response.status}, expected 200`);
      }
      await Bun.sleep(SETTLE_MS);
      expect(
        (await slackReceipts(ctx)).duplicateDeliveries === duplicatesBefore + 2,
        "The retried and replayed events were not both counted as duplicate deliveries",
      );
      const tasks = slackTasksForMessage(ctx, message.ts);
      expect(
        tasks.length === 1 && tasks[0]?.id === taskId,
        `A redelivery left ${tasks.length} tasks for the thread, expected the original only`,
      );

      await claim(flip.ctx, assignedId, taskId);
      await finish(flip.ctx, assignedId, taskId, { status: "completed", output: "done once" });
      await expectNativeTransport(ctx, flip);
    } finally {
      await flip.undo();
    }
  },
};
