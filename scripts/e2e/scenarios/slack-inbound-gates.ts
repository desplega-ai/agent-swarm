import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { putConfig, reloadConfig } from "./platform-helpers";
import {
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  retireAgent,
} from "./platformb-helpers";
import { findSlackTask, slackAbsenceWindowMs } from "./slack-helpers";

const ALICE = "U0ALICE000";
const BOB = "U0BOB00000";

/** Applies the global config now and waits for the rebuilt Slack app to reconnect. */
async function reloadSlack(ctx: ScenarioContext): Promise<void> {
  await reloadConfig(ctx);
  await ctx.slack.waitForConnection(30_000);
}

/** True when a Slack task exists for any of these trigger message timestamps. */
async function anySlackTaskFor(ctx: ScenarioContext, triggerTs: string[]): Promise<boolean> {
  const response = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100");
  expectStatus(response, [200], "list Slack tasks");
  return asRecords(response.json, "tasks").some(
    (task) =>
      triggerTs.includes(String(task.slackTriggerMessageTs)) ||
      triggerTs.includes(String(task.slackThreadTs)),
  );
}

async function taskStatus(ctx: ScenarioContext, taskId: string): Promise<unknown> {
  const response = await ctx.api("GET", `/api/tasks/${taskId}`);
  expectStatus(response, [200], `read task ${taskId}`);
  return asRecord(response.json).status;
}

/**
 * Slack input that reaches agents passes the same sender checks on every path.
 * SLACK_ALLOWED_USER_IDS applies after a config reload, to channel mentions, to
 * Assistant threads and to /agent-swarm-status. The Cancel button acts only for an
 * allowed user in the task's own channel. slack-post and slack-start-thread refuse
 * blocks that use the action ids of the swarm's own buttons.
 */
export const slackInboundGates: Scenario = {
  name: "slack-inbound-gates",
  order: 127,
  async run(ctx) {
    const leadId = await registerLead(ctx, `e2e-lead-inbound-gates-${ctx.nonce}`);
    let allowlistRow: string | undefined;
    try {
      // ── Sender allowlist, applied by a reload without a restart ─────────────
      allowlistRow = String(
        (await putConfig(ctx, { key: "SLACK_ALLOWED_USER_IDS", value: BOB })).id,
      );
      await reloadSlack(ctx);

      const mention = await ctx.slack.postMessage({
        channel: "general",
        user: "alice",
        text: `<@${ctx.slack.bot.userId}> blocked mention ${ctx.nonce}`,
      });
      const aliceThread = await ctx.slack.startAssistantThread({ user: "alice" });
      const aliceDm = await ctx.slack.postMessage({
        channel: aliceThread.channel,
        thread_ts: aliceThread.thread_ts,
        user: "alice",
        text: `blocked assistant ask ${ctx.nonce}`,
      });

      // An allowed user's Assistant message still creates a task.
      const bobThread = await ctx.slack.startAssistantThread({ user: "bob" });
      const bobDm = await ctx.slack.postMessage({
        channel: bobThread.channel,
        thread_ts: bobThread.thread_ts,
        user: "bob",
        text: `allowed assistant ask ${ctx.nonce}`,
      });
      const bobTask = await findSlackTask(ctx, bobDm.ts);
      const bobTaskId = String(bobTask.id);
      expect(
        bobTask.slackChannelId === bobThread.channel,
        `Bob's task is in ${String(bobTask.slackChannelId)}, not ${bobThread.channel}`,
      );

      const leaked = await pollUntil(
        () => anySlackTaskFor(ctx, [mention.ts, aliceDm.ts]),
        slackAbsenceWindowMs(ctx),
      );
      expect(!leaked, "A user outside SLACK_ALLOWED_USER_IDS created a Slack task after reload");

      // ── /agent-swarm-status lists agents and task summaries: allowed users only ──
      const statusFor = async (user: string): Promise<string> => {
        const seen = ctx.slack.ephemeralMessages().length;
        await ctx.slack.slashCommand({ command: "/agent-swarm-status", user, channel: "general" });
        let reply = "";
        await pollUntil(() => {
          reply = JSON.stringify(ctx.slack.ephemeralMessages().slice(seen));
          return reply !== "[]";
        }, 15_000);
        return reply;
      };
      const aliceStatus = await statusFor("alice");
      expect(
        !aliceStatus.includes("Agent Swarm Status") && aliceStatus.includes("Only users"),
        `/agent-swarm-status answered a user outside the allowlist: ${aliceStatus}`,
      );
      const bobStatus = await statusFor("bob");
      expect(
        bobStatus.includes("Agent Swarm Status"),
        `/agent-swarm-status did not answer its allowed user: ${bobStatus}`,
      );

      // ── Cancel button ────────────────────────────────────────────────────────
      // A user outside the allowlist, in the task's channel.
      await ctx.slack.clickButton({
        channel: bobThread.channel,
        ts: bobDm.ts,
        action_id: "cancel_task",
        value: bobTaskId,
        user: "alice",
      });
      // An allowed user, in a channel the task does not belong to.
      const elsewhere = await ctx.slack.postMessage({
        channel: "general",
        user: "bob",
        text: `unrelated message ${ctx.nonce}`,
      });
      await ctx.slack.clickButton({
        channel: "general",
        ts: elsewhere.ts,
        action_id: "cancel_task",
        value: bobTaskId,
        user: "bob",
      });
      const cancelledEarly = await pollUntil(
        async () => (await taskStatus(ctx, bobTaskId)) === "cancelled",
        slackAbsenceWindowMs(ctx),
      );
      expect(!cancelledEarly, "A cancel click from the wrong user or channel cancelled the task");

      // The allowed user in the task's own channel cancels it.
      await ctx.slack.clickButton({
        channel: bobThread.channel,
        ts: bobDm.ts,
        action_id: "cancel_task",
        value: bobTaskId,
        user: "bob",
      });
      const cancelled = await pollUntil(
        async () => (await taskStatus(ctx, bobTaskId)) === "cancelled",
        15_000,
      );
      expect(cancelled, `Task ${bobTaskId} was not cancelled by its allowed user`);

      // ── Reserved action ids in agent-supplied blocks ─────────────────────────
      const lead = await ctx.connectMcp(leadId);
      try {
        const button = (actionId: string) => [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: actionId,
                value: bobTaskId,
                text: { type: "plain_text", text: `button ${ctx.nonce}` },
              },
            ],
          },
        ];
        for (const [tool, actionId] of [
          ["slack-post", "cancel_task"],
          ["slack-post", "hitl_answer:approve"],
          ["slack-start-thread", "follow_up_task"],
          ["slack-start-thread", "swarm_ui:run"],
        ] as const) {
          expectToolError(
            await callTool(lead, tool, {
              channelId: "C0GENERAL0",
              message: `reserved ${actionId} ${ctx.nonce}`,
              blocks: button(actionId),
            }),
            "reserves for its own buttons",
            `${tool} with action_id ${actionId}`,
          );
        }
        expect(
          !ctx.slack
            .messages("general")
            .some((m) => m.text.includes(`reserved `) && m.text.includes(ctx.nonce)),
          "A message with a reserved action id reached Slack",
        );
        for (const tool of ["slack-post", "slack-start-thread"]) {
          expectToolOk(
            await callTool(lead, tool, {
              channelId: "C0GENERAL0",
              message: `own button ${tool} ${ctx.nonce}`,
              blocks: button(`e2e_choice_${ctx.nonce}`),
            }),
            `${tool} with an action id of its own`,
          );
        }
      } finally {
        await lead.close();
      }
    } finally {
      if (allowlistRow) {
        await ctx.api("DELETE", `/api/config/${allowlistRow}`);
        await reloadSlack(ctx);
      }
      await retireAgent(ctx, leadId);
    }
  },
};
