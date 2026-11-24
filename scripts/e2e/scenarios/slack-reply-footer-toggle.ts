import { sql } from "../db";
import { asString, expect, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolOk } from "./platformb-helpers";
import {
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

const CHANNEL = "C0GENERAL0";

async function askAndClaim(ctx: ScenarioContext, text: string) {
  const ask = await ctx.slack.postMessage({
    channel: "general",
    user: "bob",
    text: `<@${ctx.slack.bot.userId}> ${text}`,
  });
  await waitForEyes(ctx, ask.ts);
  const task = await findSlackTask(ctx, ask.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claim(ctx, leadId, taskId);
  return { threadTs: ask.ts, taskId, leadId };
}

/** Ask, complete the task with one citation, and return the outcome card's blocks as JSON. */
async function summarize(ctx: ScenarioContext, label: string) {
  const automatic = await askAndClaim(ctx, "summarize the release");
  ctx.markThread(label, CHANNEL, automatic.threadTs);
  const completing = await ctx.connectMcp(automatic.leadId);
  const summary = "Release checks passed.";
  try {
    expectToolOk(
      await callTool(completing, "store-progress", {
        taskId: automatic.taskId,
        status: "completed",
        output: `${summary} [citation:1]`,
        citations: [{ index: 1, kind: "url", ref: "https://example.com/checks", label: "Checks" }],
      }),
      "Complete the Slack task with a citation",
    );
  } finally {
    await completing.close();
  }
  const outcome = await waitForOutcome(ctx, automatic.threadTs, summary);
  const stopped = await ctx.slack.waitForApiCall("chat.stopStream", {
    timeoutMs: 30_000,
    where: (call) => call.args.ts === outcome.ts && call.args.channel === CHANNEL,
  });
  expect(stopped.ok, "The outcome did not finish streaming");
  const blocks = JSON.stringify(
    ctx.slack.messages("general").find((entry) => entry.ts === outcome.ts)?.blocks ?? [],
  );
  expect(blocks.includes("Sources:"), "The outcome lost its sources caption");
  await waitForReaction(ctx, automatic.threadTs, "white_check_mark");
  return { blocks, shortId: automatic.taskId.slice(0, 8) };
}

export const slackReplyFooterToggle: Scenario = {
  name: "slack-reply-footer-toggle",
  order: 134.5,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await ctx.restartSut({ env: { SLACK_REPLY_FOOTER_ENABLED: "false" } });
    try {
      await registerLead(ctx, `e2e-lead-footer-${ctx.nonce}`);
      const { threadTs, taskId, leadId } = await askAndClaim(ctx, "list the release checks");
      expect(
        await pollUntil(
          () =>
            !!ctx.db.get(
              sql`SELECT id FROM slack_messages WHERE kind = 'tree' AND thread_ts = ${threadTs}`,
            ),
          15_000,
        ),
        "The thread needs a task tree to exercise the reply footer condition",
      );

      const mcp = await ctx.connectMcp(leadId, { headers: { "X-Source-Task-ID": taskId } });
      try {
        const blocks = Array.from({ length: 50 }, (_, i) => ({
          type: "section",
          text: { type: "mrkdwn", text: `Release check ${i + 1}` },
        }));
        for (const [tool, target] of [
          ["slack-reply", { taskId }],
          ["slack-post", { channelId: CHANNEL, threadTs }],
        ] as const) {
          const reply = expectToolOk(
            await callTool(mcp, tool, { ...target, message: "Release checks", blocks }),
            `${tool} can send 50 blocks with the footer disabled`,
          );
          const ts = asString(reply.data.messageTs, `${tool} reply timestamp`);
          const posted = ctx.slack
            .messages("general")
            .find((entry) => entry.ts === ts && entry.thread_ts === threadTs);
          expect(posted?.blocks?.length === 50, `${tool} did not send the reply blocks`);
        }
      } finally {
        await mcp.close();
      }
      await finish(ctx, leadId, taskId, { status: "completed", output: "Release checks sent." });
      await waitForReaction(ctx, threadTs, "white_check_mark");

      const off = await summarize(ctx, "footer-off");
      expect(!off.blocks.includes(off.shortId), "The outcome still has a footer");
    } finally {
      await ctx.restartSut();
    }
    // The default setting again: the same card, with its footer. The pair is the visual proof.
    const on = await summarize(ctx, "footer-on");
    expect(on.blocks.includes(on.shortId), "The outcome has no footer with the default setting");
  },
};
