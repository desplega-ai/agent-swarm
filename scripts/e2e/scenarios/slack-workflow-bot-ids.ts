import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { putConfig, reloadConfig } from "./platform-helpers";
import { registerLead, slackAbsenceWindowMs } from "./slack-helpers";
import { createWorkflow, deleteWorkflowQuietly, getRunDetail } from "./workflow-helpers";

/**
 * Posts as a bot integration. The default is a legacy integration post
 * (`bot_message` with a `bot_id` and no `user`). With `user`, it carries the
 * bot's user id as well; with `app: true` it drops the subtype, the shape a
 * Slack app posting through chat.postMessage sends.
 */
function postAsBot(
  ctx: ScenarioContext,
  channel: string,
  botId: string,
  text: string,
  options: { user?: string; app?: boolean } = {},
): string {
  return ctx.slack.store.addMessage({
    channel,
    ...(options.app ? {} : { subtype: "bot_message" }),
    bot_id: botId,
    username: "alerts",
    text,
    ...(options.user ? { user: options.user } : {}),
  }).ts;
}

/**
 * SLACK_WORKFLOW_BOT_IDS lets a listed bot start `slack.message` workflows in its
 * listed channel only. Another channel, an unlisted bot and the swarm's own bot
 * (even when listed) start nothing, and a listed bot that @mentions the swarm
 * still creates no agent task. The mentions carry a real bot user and pin a
 * registered lead, so a listed bot falling through to the human path would
 * create a task. A malformed value is refused at write time.
 */
export const slackWorkflowBotIds: Scenario = {
  name: "slack-workflow-bot-ids",
  order: 693,
  async run(ctx) {
    const tag = ctx.nonce
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const listed = ctx.slack.addChannel({
      id: `C0BWA${tag}`,
      name: `alerts-a-${tag.toLowerCase()}`,
      withBot: true,
    }).id;
    const other = ctx.slack.addChannel({
      id: `C0BWB${tag}`,
      name: `alerts-b-${tag.toLowerCase()}`,
      withBot: true,
    }).id;
    const alertBot = `B0AL${tag}`;
    const unlistedBot = `B0UN${tag}`;
    const own = ctx.slack.bot;
    // The alerting app's bot user, a channel member, so the human path would
    // accept its posts as a sender.
    const alertUser = ctx.slack.addUser({
      id: `U0AL${tag}`,
      name: `alerts-${tag.toLowerCase()}`,
      is_bot: true,
    }).id;
    ctx.slack.invite(listed, [alertUser]);
    // `swarm#<id>` pins a mention to this lead, so routing has a target.
    const leadId = await registerLead(ctx, `e2e-lead-bot-ids-${tag.toLowerCase()}`);

    const malformed = await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key: "SLACK_WORKFLOW_BOT_IDS", value: alertBot },
    });
    expectStatus(malformed, [400], "a value without CHANNEL_ID:BOT_ID pairs is refused");

    const workflowId = await createWorkflow(
      ctx,
      "slack-workflow-bot-ids",
      { nodes: [{ id: "done", type: "script", config: { runtime: "bash", script: "echo done" } }] },
      {
        triggers: [{ type: "event", eventName: "slack.message" }],
        // Only bot posts: human messages from other scenarios never match.
        triggerSchema: {
          type: "object",
          properties: { botId: { type: "string" } },
          required: ["botId"],
        },
      },
    );
    let configRow: string | undefined;
    try {
      configRow = String(
        (
          await putConfig(ctx, {
            key: "SLACK_WORKFLOW_BOT_IDS",
            value: `${listed}:${alertBot}, ${listed}:${own.botId}`,
          })
        ).id,
      );
      await reloadConfig(ctx);
      await ctx.slack.waitForConnection(30_000);

      const deliveredBefore = ctx.slack.deliveries("message").length;
      const dropped = [
        postAsBot(ctx, other, alertBot, `wrong channel ${ctx.nonce}`),
        postAsBot(ctx, listed, unlistedBot, `unlisted bot ${ctx.nonce}`),
        postAsBot(ctx, listed, own.botId, `own bot ${ctx.nonce}`, { user: own.userId }),
      ];
      const mention = (label: string) =>
        `<@${own.userId}> swarm#${leadId} listed alert ${label} ${ctx.nonce}`;
      const listedTs = [
        postAsBot(ctx, listed, alertBot, `listed alert ${ctx.nonce}`),
        postAsBot(ctx, listed, alertBot, mention("userless mention")),
        postAsBot(ctx, listed, alertBot, mention("bot_message with user"), { user: alertUser }),
        postAsBot(ctx, listed, alertBot, mention("app post with user"), {
          user: alertUser,
          app: true,
        }),
      ];

      const acked = await pollUntil(
        () =>
          ctx.slack
            .deliveries("message")
            .slice(deliveredBefore)
            .filter((d) => d.acked).length >=
          dropped.length + listedTs.length,
        15_000,
      );
      expect(acked, "Slack did not deliver every bot post to the app");
      await new Promise((resolve) => setTimeout(resolve, slackAbsenceWindowMs(ctx)));

      // Checked before the run counts: a listed bot that falls through to the
      // human path must fail here, whatever it does to the workflow event.
      const tasks = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100");
      expectStatus(tasks, [200], "list Slack tasks");
      const botTask = asRecords(tasks.json, "tasks").find((task) =>
        [...listedTs, ...dropped].some(
          (ts) => task.slackTriggerMessageTs === ts || task.slackThreadTs === ts,
        ),
      );
      expect(!botTask, `A bot post created Slack task ${String(botTask?.id)}`);

      const runTriggers = async () => {
        const response = await ctx.api("GET", `/api/workflows/${workflowId}/runs`);
        expectStatus(response, [200], "list bot-triggered runs");
        const runs = asRecords(response.json, "runs");
        return Promise.all(
          runs.map(async (run) =>
            asRecord((await getRunDetail(ctx, asString(run.id, "run id"))).run.triggerData),
          ),
        );
      };
      let triggers: Record<string, unknown>[] = [];
      const started = await pollUntil(async () => {
        triggers = await runTriggers();
        return triggers.length >= listedTs.length;
      }, 15_000);
      expect(started, `Listed bot posts started ${triggers.length} runs, want ${listedTs.length}`);
      const seen = triggers.map((t) => String(t.ts)).sort();
      expect(
        JSON.stringify(seen) === JSON.stringify([...listedTs].sort()),
        `Runs started for ts ${seen.join(",")}, want only ${listedTs.join(",")} (dropped: ${dropped.join(",")})`,
      );
      for (const trigger of triggers) {
        expect(trigger.botId === alertBot, `triggerData.botId is ${String(trigger.botId)}`);
        expect(trigger.channel === listed, `triggerData.channel is ${String(trigger.channel)}`);
      }
    } finally {
      if (configRow) {
        await ctx.api("DELETE", `/api/config/${configRow}`);
        await reloadConfig(ctx);
        await ctx.slack.waitForConnection(30_000);
      }
      await deleteWorkflowQuietly(ctx, workflowId);
    }
  },
};
