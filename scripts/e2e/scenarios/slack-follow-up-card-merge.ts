import type { SlackMessage } from "@desplega.ai/slack-mock";
import { sql } from "../db";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
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
} from "./slack-helpers";

// One message per ask. The ask's card is an ack while its delegated work
// runs, so it carries no 👍/👎. The Lead follow-up that answers it replaces
// that ack: a quick one, with nothing posted after the ack, edits it in place
// (one chat.update, no new message) and adds the buttons. Otherwise (slower
// than SLACK_CARD_MERGE_WINDOW_SEC, failed, or the ack is no longer the last
// message) the follow-up posts a new reply, which notifies, and the ack is
// deleted after that reply posts. When Slack refuses the delete, the ack is
// edited down to a pointer instead. Two asks running at once in one thread
// each replace their own ack.
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

/** True when `message` ends with 👍/👎 buttons that vote on `taskId`. */
function hasFeedbackFor(message: SlackMessage | undefined, taskId: string): boolean {
  const rendered = JSON.stringify(message?.blocks ?? []);
  return rendered.includes('"feedback_buttons"') && rendered.includes(`"up:${taskId}"`);
}

function hasAnyFeedback(message: SlackMessage | undefined): boolean {
  return JSON.stringify(message?.blocks ?? []).includes('"feedback_buttons"');
}

function messageAt(ctx: ScenarioContext, ts: string): SlackMessage | undefined {
  return ctx.slack.messages(GENERAL).find((message) => message.ts === ts);
}

/** Waits for chat.delete of `cardTs`, and checks it came after the post that carries `answer`. */
async function expectCardDeletedAfterReply(
  ctx: ScenarioContext,
  cardTs: string,
  answer: string,
  label: string,
): Promise<void> {
  const deleteCall = await ctx.slack.waitForApiCall("chat.delete", {
    timeoutMs: 30_000,
    where: (call) => call.args.ts === cardTs && call.args.channel === GENERAL,
  });
  // The delete must come after the new reply, so a failed post never loses the card.
  const calls = ctx.slack.apiCalls();
  const replyAt = calls.findIndex((call) => JSON.stringify(call.args).includes(answer));
  expect(
    replyAt >= 0 && replyAt < calls.indexOf(deleteCall),
    `The ${label} ack was deleted before the new reply posted`,
  );
  expect(deleteCall.ok, `chat.delete of the ${label} ack failed: ${deleteCall.error}`);
  expect(!messageAt(ctx, cardTs), `The ${label} ack is still in the thread after its delete`);
}

/** The message at `ts` once its stream has stopped, so its final blocks are in. */
async function settledMessage(ctx: ScenarioContext, ts: string): Promise<SlackMessage | undefined> {
  await ctx.slack.waitForApiCall("chat.stopStream", {
    timeoutMs: 30_000,
    where: (call) => call.ok && call.args.ts === ts && call.args.channel === GENERAL,
  });
  return messageAt(ctx, ts);
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
  const ack = threadMessages(ctx, message.ts, askOutput)[0];
  expect(
    !hasAnyFeedback(ack),
    `The ${label} ack has 👍/👎 while its worker still runs: ${JSON.stringify(ack?.blocks)}`,
  );
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
  expect(
    hasFeedbackFor(await settledMessage(ctx, row.ts), ask.followUpId),
    `The slow ${label} reply has no 👍/👎 for its follow-up`,
  );
  if (!pointer) {
    await expectCardDeletedAfterReply(ctx, host.ts, answer, label);
    return;
  }
  const deleteCall = await ctx.slack.waitForApiCall("chat.delete", {
    timeoutMs: 30_000,
    where: (call) => call.args.ts === host.ts && call.args.channel === GENERAL,
  });
  const hostCard = () => messageAt(ctx, host.ts);
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

/** The Lead sends `workerId` a task from `sourceTaskId`'s session (send-task), as a real Lead does. */
async function dispatchFrom(
  ctx: ScenarioContext,
  leadId: string,
  sourceTaskId: string,
  workerId: string,
  task: string,
  parentTaskId?: string,
): Promise<string> {
  const mcp = await ctx.connectMcp(leadId, { headers: { "X-Source-Task-Id": sourceTaskId } });
  try {
    const sent = expectToolOk(
      await callTool(mcp, "send-task", {
        agentId: workerId,
        routingReason: "skill",
        routingNote: "card merge e2e specialist",
        task,
        allowDuplicate: true,
        ...(parentTaskId ? { parentTaskId } : {}),
      }),
      `dispatch "${task}"`,
    );
    return String(asRecord(sent.data.task).id);
  } finally {
    await mcp.close();
  }
}

/** Posts `text` to the bot (in `threadTs` when given), claims the ask and returns its task. */
async function postAsk(ctx: ScenarioContext, text: string, threadTs?: string) {
  const message = await ctx.slack.postMessage({
    channel: GENERAL,
    user: "alice",
    text: `<@${ctx.slack.bot.userId}> ${text}`,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claim(ctx, leadId, taskId);
  return { message, taskId, leadId };
}

/** Finishes an ask with `output` and returns its ack card's ts, once posted without buttons. */
async function ackAsk(
  ctx: ScenarioContext,
  ask: { taskId: string; leadId: string },
  threadTs: string,
  output: string,
): Promise<string> {
  await finish(ctx, ask.leadId, ask.taskId, { status: "completed", output });
  const posted = await pollUntil(
    () =>
      outcomeRow(ctx, ask.taskId)?.finalized_at != null &&
      threadMessages(ctx, threadTs, output).length > 0,
    30_000,
  );
  expect(posted, `The ack "${output}" never posted`);
  const row = outcomeRow(ctx, ask.taskId);
  if (!row) throw new Error(`The ask ${ask.taskId} has no outcome row`);
  const ack = await settledMessage(ctx, row.ts);
  expect(!hasAnyFeedback(ack), `The ack "${output}" has 👍/👎 while its worker still runs`);
  return row.ts;
}

/** Finishes `workerTaskId`, then its Lead follow-up with `answer`; returns the follow-up's card ts. */
async function answerVia(
  ctx: ScenarioContext,
  leadId: string,
  workerId: string,
  workerTaskId: string,
  answer: string,
): Promise<{ followUpId: string; ts: string }> {
  await finish(ctx, workerId, workerTaskId, { status: "completed", output: `${answer} (worker)` });
  const followUpId = await findWorkerFollowUp(ctx, leadId, workerTaskId);
  await claim(ctx, leadId, followUpId);
  await finish(ctx, leadId, followUpId, { status: "completed", output: answer });
  await pollUntil(() => outcomeRow(ctx, followUpId)?.finalized_at != null, 30_000);
  const row = outcomeRow(ctx, followUpId);
  if (!row?.finalized_at) throw new Error(`The follow-up ${followUpId} card never finalized`);
  expect(row.merged_into_id === null, `The answer "${answer}" merged into a card`);
  return { followUpId, ts: row.ts };
}

/**
 * Two back-to-back asks in one thread, each delegated, as in the thread that
 * prompted this: both acks post before either result. Each result is a new
 * reply (its ack is no longer last), carries the buttons, and deletes its own
 * ack, never the other ask's.
 */
async function concurrentAsks(ctx: ScenarioContext, workerId: string): Promise<void> {
  // Each worker holds one task at a time, so the second ask goes to a second specialist.
  const secondWorkerId = await registerWorker(ctx, "e2e-specialist-card-merge-2");
  const first = await postAsk(ctx, "concurrent first: swap the decks");
  const threadTs = first.message.ts;
  ctx.markThread("follow-up-card-merge-concurrent", GENERAL, threadTs);
  const firstWorker = await dispatchFrom(
    ctx,
    first.leadId,
    first.taskId,
    workerId,
    `concurrent first work ${ctx.nonce}`,
  );
  await claim(ctx, workerId, firstWorker);
  const firstAck = await ackAsk(ctx, first, threadTs, `concurrent first ack ${ctx.nonce}`);

  const second = await postAsk(ctx, "concurrent second: mock up the slide", threadTs);
  const secondWorker = await dispatchFrom(
    ctx,
    second.leadId,
    second.taskId,
    secondWorkerId,
    `concurrent second work ${ctx.nonce}`,
    firstWorker,
  );
  await claim(ctx, secondWorkerId, secondWorker);
  const secondAck = await ackAsk(ctx, second, threadTs, `concurrent second ack ${ctx.nonce}`);

  const firstAnswer = `concurrent first result ${ctx.nonce}`;
  const firstReply = await answerVia(ctx, first.leadId, workerId, firstWorker, firstAnswer);
  await expectCardDeletedAfterReply(ctx, firstAck, firstAnswer, "first concurrent");
  expect(messageAt(ctx, secondAck), "The first result deleted the second ask's ack");

  const secondAnswer = `concurrent second result ${ctx.nonce}`;
  const secondReply = await answerVia(
    ctx,
    second.leadId,
    secondWorkerId,
    secondWorker,
    secondAnswer,
  );
  await expectCardDeletedAfterReply(ctx, secondAck, secondAnswer, "second concurrent");
  expect(messageAt(ctx, firstReply.ts), "The second result deleted the first ask's result");

  for (const [label, reply] of [
    ["first", firstReply],
    ["second", secondReply],
  ] as const) {
    expect(
      hasFeedbackFor(await settledMessage(ctx, reply.ts), reply.followUpId),
      `The ${label} concurrent result has no 👍/👎 for its follow-up`,
    );
  }
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
    expect(
      hasFeedbackFor(carriers[0], merged.followUpId),
      `The edited ack did not gain 👍/👎 for the follow-up: ${JSON.stringify(carriers[0]?.blocks)}`,
    );
    const postedForFollowUp = [
      ...ctx.slack.apiCalls("chat.startStream"),
      ...ctx.slack.apiCalls("chat.postMessage"),
    ].filter((call) => JSON.stringify(call.args).includes(mergedOutput));
    expect(
      postedForFollowUp.length === 0,
      `The merged follow-up still posted a message: ${postedForFollowUp.length} call(s)`,
    );

    // 2. A message after the ask's card: an edit would land above it, so the
    // follow-up posts a new reply and the ack is deleted. The message
    // addresses another person, so the swarm does not route it.
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
    if (!interruptedHost) throw new Error("The interrupted ask has no outcome row");
    await expectCardDeletedAfterReply(ctx, interruptedHost.ts, interruptedOutput, "interrupted");

    // 3. A quick failed follow-up posts its own card, so it notifies, and
    // replaces the ack.
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
    const failedHost = outcomeRow(ctx, failed.askTaskId);
    if (!failedHost) throw new Error("The failed ask has no outcome row");
    await expectCardDeletedAfterReply(ctx, failedHost.ts, failureReason, "failed");

    // 4. Two asks running at once in one thread: each result replaces its
    // own ack, even when the second ask's worker continues the first one's
    // (parentTaskId points at that worker, so the parent chain leads to the
    // first ask, and only the dispatch edge names the second).
    await concurrentAsks(ctx, workerId);

    // 5. A follow-up past the merge window posts a new reply, so the requester
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
