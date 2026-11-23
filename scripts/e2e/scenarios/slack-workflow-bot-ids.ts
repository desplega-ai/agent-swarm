import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { putConfig, reloadConfig } from "./platform-helpers";
import { slackAbsenceWindowMs } from "./slack-helpers";
import { createWorkflow, deleteWorkflowQuietly, getRunDetail } from "./workflow-helpers";

/** Posts as a bot integration (`bot_message` with a `bot_id`), as Sentry or Datadog do. */
function postAsBot(
  ctx: ScenarioContext,
  channel: string,
  botId: string,
  text: string,
  user?: string,
): string {
  return ctx.slack.store.addMessage({
    channel,
    subtype: "bot_message",
    bot_id: botId,
    username: "alerts",
    text,
    ...(user ? { user } : {}),
  }).ts;
}

/**
 * SLACK_WORKFLOW_BOT_IDS lets a listed bot start `slack.message` workflows in its
 * listed channel only. Another channel, an unlisted bot and the swarm's own bot
 * (even when listed) start nothing, and a listed bot that @mentions the swarm
 * still creates no agent task. A malformed value is refused at write time.
 */
export const slackWorkflowBotIds: Scenario = {
  name: "slack-workflow-bot-ids",
  order: 693,
  async run(ctx) {
    const tag = ctx.nonce.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const listed = ctx.slack.addChannel({ id: `C0BWA${tag}`, name: `alerts-a-${tag.toLowerCase()}`, withBot: true }).id;
    const other = ctx.slack.addChannel({ id: `C0BWB${tag}`, name: `alerts-b-${tag.toLowerCase()}`, withBot: true }).id;
    const alertBot = `B0AL${tag}`;
    const unlistedBot = `B0UN${tag}`;
    const own = ctx.slack.bot;

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
        postAsBot(ctx, listed, own.botId, `own bot ${ctx.nonce}`, own.userId),
      ];
      const alertTs = postAsBot(ctx, listed, alertBot, `listed alert ${ctx.nonce}`);
      const mentionTs = postAsBot(
        ctx,
        listed,
        alertBot,
        `<@${own.userId}> listed alert with mention ${ctx.nonce}`,
      );

      const runTriggers = async () => {
        const response = await ctx.api("GET", `/api/workflows/${workflowId}/runs`);
        expectStatus(response, [200], "list bot-triggered runs");
        const runs = asRecords(response.json, "runs");
        return Promise.all(
          runs.map(async (run) => asRecord((await getRunDetail(ctx, asString(run.id, "run id"))).run.triggerData)),
        );
      };
      let triggers: Record<string, unknown>[] = [];
      const started = await pollUntil(async () => {
        triggers = await runTriggers();
        return triggers.length >= 2;
      }, 15_000);
      expect(started, `Listed bot posts started ${triggers.length} runs, want 2`);

      const acked = await pollUntil(
        () =>
          ctx.slack
            .deliveries("message")
            .slice(deliveredBefore)
            .filter((d) => d.acked).length >= 5,
        15_000,
      );
      expect(acked, "Slack did not deliver all five bot posts to the app");
      await new Promise((resolve) => setTimeout(resolve, slackAbsenceWindowMs(ctx)));

      triggers = await runTriggers();
      const seen = triggers.map((t) => String(t.ts)).sort();
      expect(
        JSON.stringify(seen) === JSON.stringify([alertTs, mentionTs].sort()),
        `Runs started for ts ${seen.join(",")}, want only ${alertTs},${mentionTs} (dropped: ${dropped.join(",")})`,
      );
      for (const trigger of triggers) {
        expect(trigger.botId === alertBot, `triggerData.botId is ${String(trigger.botId)}`);
        expect(trigger.channel === listed, `triggerData.channel is ${String(trigger.channel)}`);
      }

      const tasks = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100");
      expectStatus(tasks, [200], "list Slack tasks");
      const botTask = asRecords(tasks.json, "tasks").find((task) =>
        [alertTs, mentionTs, ...dropped].some(
          (ts) => task.slackTriggerMessageTs === ts || task.slackThreadTs === ts,
        ),
      );
      expect(!botTask, `A bot post created Slack task ${String(botTask?.id)}`);
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
