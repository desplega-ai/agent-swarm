import type { SlackMessage } from "@desplega.ai/slack-mock";
import { expect, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  claim,
  createChildTask,
  enableSlackRenderV2Only,
  findSlackTask,
  findWorkerFollowUp,
  finish,
  registerLead,
  registerWorker,
} from "./slack-helpers";

// A Lead follow-up that finishes soon after the Lead's previous card in the
// same thread merges into that card (one chat.update, no new message), so the
// thread reads as one answer and sends one notification. A later message in
// the thread, or a failed follow-up, keeps the follow-up a separate card.
//
// Runs with render v2 on and delegation off, the production state.

const GENERAL = "C0GENERAL0";

type CardRow = {
  id: string;
  ts: string;
  finalized_at: string | null;
  merged_into_id: string | null;
};

type DelegatedAsk = {
  leadId: string;
  threadTs: string;
  askTaskId: string;
  askOutput: string;
  followUpId: string;
};

function outcomeRow(ctx: ScenarioContext, taskId: string): CardRow | null {
  return ctx.db.get<CardRow>(
    "SELECT id, ts, finalized_at, merged_into_id FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
    [taskId],
  );
}

function threadMessages(ctx: ScenarioContext, threadTs: string, needle: string): SlackMessage[] {
  return ctx.slack
    .messages(GENERAL)
    .filter(
      (message) => message.thread_ts === threadTs && JSON.stringify(message).includes(needle),
    );
}

/** Ask, delegate to a worker, wait for the ask's own card, finish the worker, and claim the follow-up. */
async function delegatedAsk(
  ctx: ScenarioContext,
  workerId: string,
  label: string,
): Promise<DelegatedAsk> {
  const message = await ctx.slack.postMessage({
    channel: GENERAL,
    user: "alice",
    text: `<@${ctx.slack.bot.userId}> ${label}: get a specialist on it and report back`,
  });
  ctx.markThread(`follow-up-card-merge-${label}`, GENERAL, message.ts);
  const askTask = await findSlackTask(ctx, message.ts);
  const askTaskId = String(askTask.id);
  const leadId = String(askTask.agentId);
  await claim(ctx, leadId, askTaskId);
  const childId = await createChildTask(ctx, askTaskId, workerId, `${label} ${ctx.nonce}`);
  await claim(ctx, workerId, childId);
  const askOutput = `${label} ask answer ${ctx.nonce}`;
  await finish(ctx, leadId, askTaskId, { status: "completed", output: askOutput });
  const askCard = await pollUntil(
    () =>
      outcomeRow(ctx, askTaskId)?.finalized_at != null &&
      threadMessages(ctx, message.ts, askOutput).length > 0,
    30_000,
  );
  expect(askCard, `The ${label} ask's own outcome card never posted`);
  await finish(ctx, workerId, childId, {
    status: "completed",
    output: `${label} worker result ${ctx.nonce}`,
  });
  const followUpId = await findWorkerFollowUp(ctx, leadId, childId);
  await claim(ctx, leadId, followUpId);
  return { leadId, threadTs: message.ts, askTaskId, askOutput, followUpId };
}

/** Waits until the follow-up's outcome row is finalized, and returns it. */
async function settledFollowUpRow(ctx: ScenarioContext, ask: DelegatedAsk): Promise<CardRow> {
  await pollUntil(() => outcomeRow(ctx, ask.followUpId)?.finalized_at != null, 30_000);
  const row = outcomeRow(ctx, ask.followUpId);
  if (!row?.finalized_at) {
    throw new Error(`The follow-up ${ask.followUpId} card never finalized: ${JSON.stringify(row)}`);
  }
  return row;
}

export const slackFollowUpCardMerge: Scenario = {
  name: "slack-follow-up-card-merge",
  // Band 2 (130-140): render v2 on, delegation off.
  order: 130.6,
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, "e2e-lead-card-merge");
    const workerId = await registerWorker(ctx, "e2e-specialist-card-merge");

    // 1. The follow-up merges into the ask's card: same Slack message, both
    // answers in order, one footer with both task links.
    const merged = await delegatedAsk(ctx, workerId, "merged");
    const hostRow = outcomeRow(ctx, merged.askTaskId);
    if (!hostRow) throw new Error(`The ask ${merged.askTaskId} has no outcome row`);
    const mergedOutput = `follow-up review merged ${ctx.nonce}`;
    await finish(ctx, merged.leadId, merged.followUpId, {
      status: "completed",
      output: mergedOutput,
    });
    const mergedRow = await settledFollowUpRow(ctx, merged);
    expect(
      mergedRow.merged_into_id === hostRow.id && mergedRow.ts.startsWith("merged:"),
      `The follow-up row is not merged into the ask's card: ${JSON.stringify(mergedRow)}`,
    );
    const carriers = threadMessages(ctx, merged.threadTs, mergedOutput);
    expect(
      carriers.length === 1 && carriers[0]?.ts === hostRow.ts,
      `The follow-up answer is not in the ask's card ${hostRow.ts}: ${JSON.stringify(carriers.map((m) => m.ts))}`,
    );
    const hostBody = JSON.stringify(carriers[0]);
    expect(
      hostBody.indexOf(merged.askOutput) >= 0 &&
        hostBody.indexOf(merged.askOutput) < hostBody.indexOf(mergedOutput),
      "The merged card does not show the ask's answer before the follow-up's answer",
    );
    expect(
      hostBody.includes(merged.askTaskId.slice(0, 8)) &&
        hostBody.includes(merged.followUpId.slice(0, 8)),
      "The merged card's footer does not link both tasks",
    );
    const postedForFollowUp = [
      ...ctx.slack.apiCalls("chat.startStream"),
      ...ctx.slack.apiCalls("chat.postMessage"),
    ].filter((call) => JSON.stringify(call.args).includes(mergedOutput));
    expect(
      postedForFollowUp.length === 0,
      `The merged follow-up still posted a message: ${postedForFollowUp.length} call(s)`,
    );

    // 2. A message after the ask's card keeps the follow-up a separate card.
    // The reply addresses another person, so the swarm does not route it.
    const interrupted = await delegatedAsk(ctx, workerId, "interrupted");
    const bob = ctx.slack.user("bob").id;
    await ctx.slack.postMessage({
      channel: GENERAL,
      user: "alice",
      thread_ts: interrupted.threadTs,
      text: `<@${bob}> side note ${ctx.nonce}`,
    });
    const interruptedOutput = `follow-up review interrupted ${ctx.nonce}`;
    await finish(ctx, interrupted.leadId, interrupted.followUpId, {
      status: "completed",
      output: interruptedOutput,
    });
    const interruptedRow = await settledFollowUpRow(ctx, interrupted);
    const interruptedHost = outcomeRow(ctx, interrupted.askTaskId);
    expect(
      interruptedRow.merged_into_id === null && interruptedRow.ts !== interruptedHost?.ts,
      `The follow-up merged across a later thread message: ${JSON.stringify(interruptedRow)}`,
    );
    const ownCard = threadMessages(ctx, interrupted.threadTs, interruptedOutput);
    expect(
      ownCard.length === 1 && ownCard[0]?.ts === interruptedRow.ts,
      `The interrupted follow-up did not post its own card: ${JSON.stringify(ownCard.map((m) => m.ts))}`,
    );

    // 3. A failed follow-up stays a separate card.
    const failed = await delegatedAsk(ctx, workerId, "failed");
    const failureReason = `follow-up review failed ${ctx.nonce}`;
    await finish(ctx, failed.leadId, failed.followUpId, {
      status: "failed",
      failureReason,
    });
    const failedRow = await settledFollowUpRow(ctx, failed);
    expect(
      failedRow.merged_into_id === null,
      `A failed follow-up merged into the previous card: ${JSON.stringify(failedRow)}`,
    );
    const failedCard = threadMessages(ctx, failed.threadTs, failureReason);
    expect(
      failedCard.length === 1 && failedCard[0]?.ts === failedRow.ts,
      "The failed follow-up did not post its own card",
    );
  },
};
