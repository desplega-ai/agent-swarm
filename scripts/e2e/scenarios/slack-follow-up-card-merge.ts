import type { SlackMessage } from "@desplega.ai/slack-mock";
import { sql } from "../db";
import { expect, expectStatus, pollUntil } from "../http";
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
// same thread, with nothing posted in between, merges into that card (one
// chat.update, no new message), so the thread reads as one answer. A later
// message in the thread keeps the follow-up a separate card. A follow-up that
// finishes after SLACK_CARD_MERGE_WINDOW_SEC posts a new reply, because an
// edit sends no notification, and the previous card is deleted after that
// reply posts. When Slack refuses the delete, the previous card is edited
// down to a pointer instead. A failed follow-up always posts its own card.
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
    sql`SELECT id, ts, finalized_at, merged_into_id FROM slack_messages WHERE kind = 'outcome' AND task_id = ${taskId}`,
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

/** Sets SLACK_CARD_MERGE_WINDOW_SEC and loads it into the running server. */
async function setMergeWindow(ctx: ScenarioContext, seconds: string): Promise<void> {
  expectStatus(
    await ctx.api("PUT", "/api/config", {
      body: {
        scope: "global",
        scopeId: null,
        key: "SLACK_CARD_MERGE_WINDOW_SEC",
        value: seconds,
        isSecret: false,
      },
    }),
    [200],
    "set SLACK_CARD_MERGE_WINDOW_SEC",
  );
  expectStatus(await ctx.api("POST", "/api/config/reload", { body: {} }), [200], "reload config");
}

/**
 * A follow-up that ends after the 1s merge window: own card, then the ask's
 * card is deleted. With `pointer` set, Slack refuses that delete, and the
 * ask's card is edited down to `pointer` instead.
 */
async function expectSlowFollowUpReply(
  ctx: ScenarioContext,
  workerId: string,
  label: string,
  status: "completed" | "failed",
  pointer?: string,
): Promise<void> {
  const ask = await delegatedAsk(ctx, workerId, label);
  const host = outcomeRow(ctx, ask.askTaskId);
  if (!host) throw new Error(`The ${label} ask ${ask.askTaskId} has no outcome row`);
  await Bun.sleep(1_500);
  if (pointer) ctx.slack.injectFault({ method: "chat.delete", error: "cant_delete_message" });
  const answer = `follow-up review ${label} ${ctx.nonce}`;
  await finish(
    ctx,
    ask.leadId,
    ask.followUpId,
    status === "failed" ? { status, failureReason: answer } : { status, output: answer },
  );
  const row = await settledFollowUpRow(ctx, ask);
  expect(
    row.merged_into_id === null && row.ts !== host.ts,
    `The slow ${label} follow-up merged into the ask's card: ${JSON.stringify(row)}`,
  );
  const ownCard = threadMessages(ctx, ask.threadTs, answer);
  expect(
    ownCard.length === 1 && ownCard[0]?.ts === row.ts,
    `The slow ${label} follow-up did not post a new reply: ${JSON.stringify(ownCard.map((m) => m.ts))}`,
  );
  const deleteCall = await ctx.slack.waitForApiCall("chat.delete", {
    timeoutMs: 30_000,
    where: (call) => call.args.ts === host.ts && call.args.channel === GENERAL,
  });
  // The delete must come after the new reply, so a failed post never loses the card.
  const calls = ctx.slack.apiCalls();
  const replyAt = calls.findIndex((call) => JSON.stringify(call.args).includes(answer));
  expect(
    replyAt >= 0 && replyAt < calls.indexOf(deleteCall),
    `The ${label} ask's card was deleted before the new reply posted`,
  );
  const hostCard = () => ctx.slack.messages(GENERAL).find((message) => message.ts === host.ts);
  if (!pointer) {
    expect(deleteCall.ok, `chat.delete of the ${label} ask's card failed: ${deleteCall.error}`);
    expect(!hostCard(), `The ${label} ask's card is still in the thread after its delete`);
    return;
  }
  expect(!deleteCall.ok, `The injected chat.delete fault did not hit the ${label} ask's card`);
  const pointed = await pollUntil(() => {
    const card = hostCard();
    return card?.text === pointer && !JSON.stringify(card).includes(ask.askOutput);
  }, 30_000);
  expect(
    pointed,
    `The ${label} ask's card was not edited down to "${pointer}" after the delete failed`,
  );
}

export const slackFollowUpCardMerge: Scenario = {
  name: "slack-follow-up-card-merge",
  // Band 2 (130-140): render v2 on, delegation off.
  order: 130.6,
  groups: ["visuals-v2"],
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

    // 3. A quick failed follow-up stays a separate card, so it notifies.
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

    // 4. A follow-up past the merge window posts a new reply, so the requester
    // is notified, and the ask's card is then deleted. When Slack refuses the
    // delete, the ask's card becomes a pointer to the new reply.
    await setMergeWindow(ctx, "1");
    try {
      await expectSlowFollowUpReply(ctx, workerId, "slow-done", "completed");
      await expectSlowFollowUpReply(ctx, workerId, "slow-failed", "failed", "❌ Failed ↓");
    } finally {
      await setMergeWindow(ctx, "120");
    }
  },
};
