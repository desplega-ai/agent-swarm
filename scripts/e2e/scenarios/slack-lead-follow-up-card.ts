import type { SlackMessage } from "@desplega.ai/slack-mock";
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
  slackAbsenceWindowMs,
} from "./slack-helpers";

// A worker finishing inside a Slack ask creates a Lead follow-up task
// (source 'system', taskType 'follow-up') that inherits the thread. Its
// output is the answer the person waits for, so it posts an outcome card
// like the ask did. Before the fix it posted nothing and the person only saw
// the result after asking "status?".
//
// Runs with render v2 on and delegation off, the production state.

const GENERAL = "C0GENERAL0";

type DelegatedAsk = { leadId: string; threadTs: string; followUpId: string };

function threadMessages(
  ctx: ScenarioContext,
  channel: string,
  threadTs: string,
  needle: string,
): SlackMessage[] {
  return ctx.slack
    .messages(channel)
    .filter(
      (message) => message.thread_ts === threadTs && JSON.stringify(message).includes(needle),
    );
}

/** The task's outcome card row is finalized in the thread it was asked in. */
async function expectFinalizedCard(
  ctx: ScenarioContext,
  taskId: string,
  threadTs: string,
  label: string,
): Promise<void> {
  type CardRow = { thread_ts: string; finalized_at: string | null };
  const read = () =>
    ctx.db.get<CardRow>(
      "SELECT thread_ts, finalized_at FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
      [taskId],
    );
  // The message lands in Slack at chat.startStream; finalized_at is written
  // only after stopStream, the status clear and the permalink read. Wait for it.
  await pollUntil(() => {
    const row = read();
    return row?.thread_ts === threadTs && row.finalized_at !== null;
  }, 15_000);
  const card = read();
  expect(
    card?.thread_ts === threadTs && card.finalized_at !== null,
    `The ${label} ${taskId} has no finalized outcome card in thread ${threadTs}: ${JSON.stringify(card)}`,
  );
}

/** Ask in channel id `channel`, delegate to a worker, finish both, and claim the Lead's follow-up. */
async function delegatedAsk(
  ctx: ScenarioContext,
  channel: string,
  workerId: string,
  label: string,
): Promise<DelegatedAsk> {
  const message = await ctx.slack.postMessage({
    channel,
    user: "alice",
    text: `<@${ctx.slack.bot.userId}> ${label}: get a specialist on it and report back`,
  });
  ctx.markThread(`lead-follow-up-${label}`, channel, message.ts);
  const askTask = await findSlackTask(ctx, message.ts);
  const askTaskId = String(askTask.id);
  const leadId = String(askTask.agentId);
  await claim(ctx, leadId, askTaskId);
  const childId = await createChildTask(ctx, askTaskId, workerId, `${label} ${ctx.nonce}`);
  await claim(ctx, workerId, childId);

  // source='slack' behaviour is unchanged: the ask posts its own card.
  const askOutput = `${label} ask answer ${ctx.nonce}`;
  await finish(ctx, leadId, askTaskId, { status: "completed", output: askOutput });
  const askCard = await pollUntil(
    () => threadMessages(ctx, channel, message.ts, askOutput).length > 0,
    30_000,
  );
  expect(askCard, `The ${label} ask's own outcome card never posted in ${channel}`);

  await finish(ctx, workerId, childId, {
    status: "completed",
    output: `${label} worker result ${ctx.nonce}`,
  });
  const followUpId = await findWorkerFollowUp(ctx, leadId, childId);
  await claim(ctx, leadId, followUpId);
  return { leadId, threadTs: message.ts, followUpId };
}

export const slackLeadFollowUpCard: Scenario = {
  name: "slack-lead-follow-up-card",
  // Band 2 (130-140): render v2 on, delegation off.
  order: 130.5,
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, "e2e-lead-follow-up-card");
    const workerId = await registerWorker(ctx, "e2e-specialist-follow-up-card");

    // 1. The follow-up's output posts once in the ask's thread.
    const posted = await delegatedAsk(ctx, GENERAL, workerId, "posted");
    const postedOutput = `follow-up review posted ${ctx.nonce}`;
    await finish(ctx, posted.leadId, posted.followUpId, {
      status: "completed",
      output: postedOutput,
    });
    const landed = await pollUntil(
      () => threadMessages(ctx, GENERAL, posted.threadTs, postedOutput).length > 0,
      30_000,
    );
    expect(landed, "The Lead follow-up's outcome card never posted in the ask's thread");
    // Watch several ticks: the card must not repeat.
    await pollUntil(() => false, slackAbsenceWindowMs(ctx));
    const copies = threadMessages(ctx, GENERAL, posted.threadTs, postedOutput).length;
    expect(copies === 1, `The Lead follow-up's outcome posted ${copies} times, expected 1`);
    await expectFinalizedCard(ctx, posted.followUpId, posted.threadTs, "worker follow-up");

    // 1b. A Lead follow-up pinned to the thread by hand, with no Slack ask in
    // its parent chain, posts nothing and settles its card so the thread closes.
    const pinConn = await ctx.connectMcp(posted.leadId);
    let pinnedId = "";
    try {
      const sent = expectToolOk(
        await callTool(pinConn, "send-task", {
          agentId: workerId,
          task: `pinned worker task ${ctx.nonce}`,
          routingReason: "skill",
          routingNote: "e2e: a worker task pinned to a Slack thread by hand",
          slackChannelId: GENERAL,
          slackThreadTs: posted.threadTs,
        }),
        "send-task pinned to the thread",
      );
      pinnedId = String(asRecord(sent.data.task).id);
    } finally {
      await pinConn.close();
    }
    await claim(ctx, workerId, pinnedId);
    await finish(ctx, workerId, pinnedId, { status: "completed", output: "pinned worker done" });
    const pinnedFollowUpId = await findWorkerFollowUp(ctx, posted.leadId, pinnedId);
    await claim(ctx, posted.leadId, pinnedFollowUpId);
    const pinnedOutput = `pinned follow-up review ${ctx.nonce}`;
    await finish(ctx, posted.leadId, pinnedFollowUpId, {
      status: "completed",
      output: pinnedOutput,
    });
    const pinnedSettled = await pollUntil(
      () =>
        ctx.db.get<{ delivery_abandoned_at: string | null }>(
          "SELECT delivery_abandoned_at FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
          [pinnedFollowUpId],
        )?.delivery_abandoned_at != null,
      30_000,
    );
    expect(pinnedSettled, "The pinned follow-up's card was never settled as abandoned");
    expect(
      threadMessages(ctx, GENERAL, posted.threadTs, pinnedOutput).length === 0,
      "A Lead follow-up with no Slack ask in its parent chain posted a card",
    );

    // 2. A graceful-shutdown resume of the ask posts its output the same way.
    const resumeAsk = await ctx.slack.postMessage({
      channel: GENERAL,
      user: "alice",
      text: `<@${ctx.slack.bot.userId}> resume: answer after a restart`,
    });
    ctx.markThread("lead-follow-up-resume", GENERAL, resumeAsk.ts);
    const resumeAskTask = await findSlackTask(ctx, resumeAsk.ts);
    const resumeLeadId = String(resumeAskTask.agentId);
    await claim(ctx, resumeLeadId, String(resumeAskTask.id));
    const superseded = await ctx.api("POST", `/api/tasks/${String(resumeAskTask.id)}/supersede`, {
      agentId: resumeLeadId,
      body: { reason: "graceful_shutdown" },
    });
    expectStatus(superseded, [200], "supersede the Slack ask on graceful shutdown");
    const resumeId = String(asRecord(superseded.json).resumeTaskId);
    const resume = ctx.db.get<{ source: string; taskType: string; slackThreadTs: string }>(
      "SELECT source, taskType, slackThreadTs FROM agent_tasks WHERE id = ?",
      [resumeId],
    );
    expect(
      resume?.source === "system" &&
        resume.taskType === "resume" &&
        resume.slackThreadTs === resumeAsk.ts,
      `Resume ${resumeId} is not a system resume in the ask's thread: ${JSON.stringify(resume)}`,
    );
    await claim(ctx, resumeLeadId, resumeId);
    const resumeOutput = `resume answer ${ctx.nonce}`;
    await finish(ctx, resumeLeadId, resumeId, { status: "completed", output: resumeOutput });
    const resumed = await pollUntil(
      () => threadMessages(ctx, GENERAL, resumeAsk.ts, resumeOutput).length > 0,
      30_000,
    );
    expect(resumed, "The Lead resume task's outcome card never posted in the ask's thread");
    await expectFinalizedCard(ctx, resumeId, resumeAsk.ts, "resume");

    // 3. Negative control: a follow-up with no Slack context posts nothing.
    const plainRes = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `plain worker task ${ctx.nonce}`,
        routingReason: "human_pinned",
        agentId: workerId,
        source: "api",
      },
    });
    expectStatus(plainRes, [201], "create a worker task outside Slack");
    const plainId = String(asRecord(plainRes.json).id);
    await claim(ctx, workerId, plainId);
    await finish(ctx, workerId, plainId, { status: "completed", output: "plain worker done" });
    type FollowUpRow = { id: string; agentId: string; slackChannelId: string | null };
    const readPlain = () =>
      ctx.db.get<FollowUpRow>(
        "SELECT id, agentId, slackChannelId FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
        [plainId],
      );
    await pollUntil(() => readPlain() !== null, 15_000);
    const plain = readPlain();
    if (!plain) throw new Error(`No Lead follow-up for plain worker task ${plainId}`);
    expect(plain.slackChannelId === null, "The plain follow-up inherited a Slack channel");
    await claim(ctx, plain.agentId, plain.id);
    const plainOutput = `plain follow-up review ${ctx.nonce}`;
    await finish(ctx, plain.agentId, plain.id, { status: "completed", output: plainOutput });
    const plainPosted = await pollUntil(
      () => JSON.stringify(ctx.slack.messages(GENERAL)).includes(plainOutput),
      slackAbsenceWindowMs(ctx),
    );
    expect(!plainPosted, "A follow-up with no Slack context posted to Slack");
    expect(
      !ctx.db.get("SELECT 1 FROM slack_messages WHERE task_id = ?", [plain.id]),
      "A follow-up with no Slack context got a slack_messages row",
    );

    // 4. No card when the Lead already answered with slack-reply.
    const replied = await delegatedAsk(ctx, GENERAL, workerId, "replied");
    const replyText = `follow-up hand reply ${ctx.nonce}`;
    const conn = await ctx.connectMcp(replied.leadId);
    try {
      expectToolOk(
        await callTool(conn, "slack-reply", { taskId: replied.followUpId, message: replyText }),
        "slack-reply from the Lead follow-up",
      );
    } finally {
      await conn.close();
    }
    const repliedOutput = `follow-up review replied ${ctx.nonce}`;
    await finish(ctx, replied.leadId, replied.followUpId, {
      status: "completed",
      output: repliedOutput,
    });
    const doubled = await pollUntil(
      () => threadMessages(ctx, GENERAL, replied.threadTs, repliedOutput).length > 0,
      slackAbsenceWindowMs(ctx),
    );
    expect(!doubled, "The Lead follow-up posted a card after it already sent slack-reply");
    const replies = threadMessages(ctx, GENERAL, replied.threadTs, replyText).length;
    expect(replies === 1, `The Lead's slack-reply landed ${replies} times, expected 1`);

    // 5. No card in a Slack Connect channel. The mock always reports channels
    // as internal, so one injected conversations.info answer marks this fresh
    // channel external; the API caches that verdict for 10 minutes.
    const externalId = `C0EXT${ctx.nonce.slice(0, 5).toUpperCase()}`;
    const alice = ctx.slack.user("alice").id;
    ctx.slack.addChannel({
      id: externalId,
      name: `ext-${ctx.nonce.toLowerCase()}`,
      members: [alice],
    });
    const external = await delegatedAsk(ctx, externalId, workerId, "external");
    const faultCode = "e2e_ext_shared";
    ctx.slack.injectFault({
      method: "conversations.info",
      error: faultCode,
      extra: { ok: true, channel: { id: externalId, is_ext_shared: true } },
    });
    const externalOutput = `follow-up review external ${ctx.nonce}`;
    await finish(ctx, external.leadId, external.followUpId, {
      status: "completed",
      output: externalOutput,
    });
    const leaked = await pollUntil(
      () => threadMessages(ctx, externalId, external.threadTs, externalOutput).length > 0,
      slackAbsenceWindowMs(ctx),
    );
    expect(!leaked, "The Lead follow-up posted its card into a Slack Connect channel");
    // Control: the gate asked Slack about this channel and got the external answer.
    const consulted = ctx.slack
      .apiCalls("conversations.info")
      .some((call) => call.args.channel === externalId && call.error === faultCode);
    expect(consulted, `The external-channel gate never classified ${externalId} via Slack`);
    // The skipped card is settled, so the thread stops owing outcome work.
    const settled = ctx.db.get<{
      delivery_abandoned_at: string | null;
      finalized_at: string | null;
    }>(
      "SELECT delivery_abandoned_at, finalized_at FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
      [external.followUpId],
    );
    expect(
      settled?.delivery_abandoned_at != null && settled.finalized_at === null,
      `The external follow-up's card is not settled as abandoned: ${JSON.stringify(settled)}`,
    );

    // 6. Recovery of a reservation whose delivery failed. A restart drops the
    // retry backoff, so both cards are retried from the persisted row. The one
    // without a reply posts once; the one the Lead answered with slack-reply
    // posts nothing and is settled so the thread closes.
    const failDelivery = async (ask: DelegatedAsk, output: string) => {
      // A message after the ask's card stops the follow-up from merging into
      // that card (slack-follow-up-card-merge), so it posts its own card and
      // the injected faults below hit it. It addresses another person, so the
      // swarm does not route it.
      await ctx.slack.postMessage({
        channel: GENERAL,
        user: "alice",
        thread_ts: ask.threadTs,
        text: `<@${ctx.slack.user("bob").id}> side note ${ctx.nonce}`,
      });
      ctx.slack.injectFault({ method: "chat.startStream", error: "internal_error" });
      ctx.slack.injectFault({ method: "chat.postMessage", error: "internal_error" });
      await finish(ctx, ask.leadId, ask.followUpId, { status: "completed", output });
      const failed = await pollUntil(
        () =>
          (ctx.db.get<{ delivery_attempts: number }>(
            "SELECT delivery_attempts FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
            [ask.followUpId],
          )?.delivery_attempts ?? 0) > 0,
        15_000,
      );
      expect(failed, `The ${ask.followUpId} delivery never failed into a pending reservation`);
    };
    const recoveredOutput = `follow-up review recovered ${ctx.nonce}`;
    const suppressedOutput = `follow-up review suppressed ${ctx.nonce}`;
    // The Lead holds one task at a time, so each follow-up finishes before the
    // next ask. Both land inside the 30s retry backoff.
    const recovered = await delegatedAsk(ctx, GENERAL, workerId, "recovered");
    await failDelivery(recovered, recoveredOutput);
    const suppressed = await delegatedAsk(ctx, GENERAL, workerId, "suppressed");
    await failDelivery(suppressed, suppressedOutput);
    const lateReply = `late hand reply ${ctx.nonce}`;
    const lateConn = await ctx.connectMcp(suppressed.leadId);
    try {
      expectToolOk(
        await callTool(lateConn, "slack-reply", {
          taskId: suppressed.followUpId,
          message: lateReply,
        }),
        "slack-reply after a failed follow-up delivery",
      );
    } finally {
      await lateConn.close();
    }
    const suppressedThread = () =>
      ctx.slack.messages(GENERAL).filter((message) => message.thread_ts === suppressed.threadTs);
    const replyLanded = await pollUntil(
      () => suppressedThread().some((message) => JSON.stringify(message).includes(lateReply)),
      15_000,
    );
    expect(replyLanded, "The late slack-reply never reached the thread");
    const beforeRestart = new Set(suppressedThread().map((message) => message.ts));
    await ctx.restartSut();
    const recoveredPosted = await pollUntil(
      () => threadMessages(ctx, GENERAL, recovered.threadTs, recoveredOutput).length > 0,
      30_000,
    );
    expect(recoveredPosted, "The failed Lead follow-up card was not recovered after a restart");
    const recoveredCopies = threadMessages(ctx, GENERAL, recovered.threadTs, recoveredOutput);
    expect(
      recoveredCopies.length === 1,
      `The recovered follow-up posted ${recoveredCopies.length} times, expected 1`,
    );
    await expectFinalizedCard(ctx, recovered.followUpId, recovered.threadTs, "recovered follow-up");
    type CardRow = { delivery_abandoned_at: string | null; finalized_at: string | null };
    const suppressedCard = () =>
      ctx.db.get<CardRow>(
        "SELECT delivery_abandoned_at, finalized_at FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
        [suppressed.followUpId],
      );
    await pollUntil(() => {
      const card = suppressedCard();
      return card?.delivery_abandoned_at != null || card?.finalized_at != null;
    }, 30_000);
    // Any new message counts: with slackReplySent=1 the card body is a
    // "<Lead> completed" line, not the output.
    const extra = suppressedThread().filter((message) => !beforeRestart.has(message.ts));
    expect(
      extra.length === 0,
      `The replied follow-up posted after slackReplySent=1: ${JSON.stringify(extra)}`,
    );
    const suppressedRow = suppressedCard();
    expect(
      suppressedRow?.delivery_abandoned_at != null && suppressedRow.finalized_at === null,
      `The replied follow-up's pending card is not settled as abandoned: ${JSON.stringify(suppressedRow)}`,
    );
  },
};
