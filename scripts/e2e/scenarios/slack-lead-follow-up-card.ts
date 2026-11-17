import type { SlackMessage } from "@desplega.ai/slack-mock";
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

    // 2. No card when the Lead already answered with slack-reply.
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

    // 3. No card in a Slack Connect channel. The mock always reports channels
    // as internal, so one injected conversations.info answer marks this fresh
    // channel external; the API caches that verdict for 10 minutes.
    const externalId = `C0EXT${ctx.nonce.slice(0, 5).toUpperCase()}`;
    const alice = ctx.slack.user("alice").id;
    ctx.slack.addChannel({ id: externalId, name: `ext-${ctx.nonce.toLowerCase()}`, members: [alice] });
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
  },
};
