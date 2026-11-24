import { sql } from "../db";
import { expect, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolOk } from "./platformb-helpers";
import {
  claim,
  createChildTask,
  enableSlackRenderV2Only,
  findSlackTask,
  findWorkerFollowUp,
  finish,
  registerLead,
  registerWorker,
  slackAbsenceWindowMs,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

const CHANNEL = "C0GENERAL0";
const FOLLOW_UP_NOTE = "I posted nothing in Slack: the review is still running.";

type Workers = { reviewerId: string; writerId: string };

/** The thread's bot and agent messages, without the task tree. */
function threadReplies(ctx: ScenarioContext, threadTs: string): string[] {
  return ctx.slack
    .messages("general")
    .filter((entry) => entry.thread_ts === threadTs && entry.ts !== threadTs)
    .map((entry) => String(entry.text ?? ""))
    .filter((text) => !text.startsWith("🧵"));
}

function cardAbandoned(ctx: ScenarioContext, taskId: string): boolean {
  return (
    ctx.db.get<{ delivery_abandoned_at: string | null }>(
      sql`SELECT delivery_abandoned_at FROM slack_messages WHERE kind = 'outcome' AND task_id = ${taskId}`,
    )?.delivery_abandoned_at != null
  );
}

/**
 * The Lead hands a review and a draft to two workers, waits on the review
 * with `defer-task`, notes the draft in a follow-up without replying, and
 * answers once with `slack-reply` from the wake-up.
 */
async function fanOutAndReplyOnce(
  ctx: ScenarioContext,
  label: string,
  { reviewerId, writerId }: Workers,
  quiet: boolean,
): Promise<void> {
  const message = await ctx.slack.postMessage({
    channel: "general",
    user: "bob",
    text: `<@${ctx.slack.bot.userId}> ship the onboarding guide once it is reviewed`,
  });
  ctx.markThread(label, CHANNEL, message.ts);
  await waitForEyes(ctx, message.ts);
  const ask = await findSlackTask(ctx, message.ts);
  const askId = String(ask.id);
  const leadId = String(ask.agentId);
  await claim(ctx, leadId, askId);
  const reviewId = await createChildTask(ctx, askId, reviewerId, "Review the onboarding guide");
  const draftId = await createChildTask(ctx, askId, writerId, "Draft the release note");
  await claim(ctx, reviewerId, reviewId);
  await claim(ctx, writerId, draftId);

  const mcp = await ctx.connectMcp(leadId);
  try {
    const deferred = await mcp.callTool("defer-task", {
      taskId: askId,
      delayMs: 86_400_000,
      wakeOn: { event: "settled", taskId: reviewId },
      summary: "Asked Reviewer to review and Writer to draft the note.",
      note: "Ship once the review is in.",
    });
    expect(!deferred.isError, `defer-task failed: ${JSON.stringify(deferred)}`);
    if (quiet) {
      expect(
        await pollUntil(() => cardAbandoned(ctx, askId), 30_000),
        "The quiet deferral card was never settled",
      );
    } else {
      await waitForOutcome(ctx, message.ts, "Waiting on ");
    }

    // The draft is not waited on, so it books a Lead follow-up that stays quiet.
    await finish(ctx, writerId, draftId, { status: "completed", output: "Release note drafted." });
    const followUpId = await findWorkerFollowUp(ctx, leadId, draftId);
    await claim(ctx, leadId, followUpId);
    await finish(ctx, leadId, followUpId, { status: "completed", output: FOLLOW_UP_NOTE });
    if (quiet) {
      expect(
        await pollUntil(() => cardAbandoned(ctx, followUpId), 30_000),
        "The quiet follow-up card was never settled",
      );
    } else {
      await waitForOutcome(ctx, message.ts, FOLLOW_UP_NOTE);
    }

    await finish(ctx, reviewerId, reviewId, { status: "completed", output: "Approved." });
    let wakeId = "";
    await pollUntil(() => {
      wakeId =
        ctx.db.get<{ id: string }>(
          sql`SELECT id FROM agent_tasks WHERE "parentTaskId" = ${askId} AND "taskType" = 'deferred'`,
        )?.id ?? "";
      return wakeId !== "";
    }, 15_000);
    expect(wakeId, `No wake-up task for ${askId}`);
    await claim(ctx, leadId, wakeId);
    expectToolOk(
      await callTool(mcp, "slack-reply", {
        taskId: wakeId,
        message: `The onboarding guide is reviewed and shipped ${ctx.nonce}`,
      }),
      "slack-reply from the wake-up",
    );
    await finish(ctx, leadId, wakeId, { status: "completed", output: "Replied in the thread." });
  } finally {
    await mcp.close();
  }
  await waitForReaction(ctx, message.ts, "white_check_mark");

  if (!quiet) return;
  // A late card would land within a few render ticks.
  await pollUntil(() => threadReplies(ctx, message.ts).length > 1, slackAbsenceWindowMs(ctx));
  const replies = threadReplies(ctx, message.ts);
  expect(
    replies.length === 1 && replies[0]!.includes(`reviewed and shipped ${ctx.nonce}`),
    `A quiet Lead thread should hold only the Lead's reply: ${JSON.stringify(replies)}`,
  );
}

export const slackQuietLeadThreads: Scenario = {
  name: "slack-quiet-lead-threads",
  // Band 2 (130-140): render v2 on, delegation off.
  order: 134.6,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, `e2e-lead-quiet-${ctx.nonce}`);
    const workers = {
      reviewerId: await registerWorker(ctx, "Reviewer"),
      writerId: await registerWorker(ctx, "Writer"),
    };
    await fanOutAndReplyOnce(ctx, "quiet-off", workers, false);
    await ctx.restartSut({ env: { SLACK_RENDER_V2_QUIET_LEAD_THREADS: "true" } });
    try {
      await ctx.slack.waitForConnection(60_000);
      await fanOutAndReplyOnce(ctx, "quiet-on", workers, true);
    } finally {
      await ctx.restartSut();
    }
  },
};
