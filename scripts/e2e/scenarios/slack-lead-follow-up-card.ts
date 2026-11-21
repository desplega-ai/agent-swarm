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

type DelegatedAsk = { leadId: string; threadTs: string; askTaskId: string; followUpId: string };
type WorkerAttachment =
  | { kind: "url"; url: string; name: string }
  | { kind: "page"; pageId: string; name: string };
type WorkerResult = { output: string; attachments: WorkerAttachment[] };

/**
 * How many times `needle` appears in the captions (context blocks) of the
 * thread's messages that contain `anchor`. The answer itself is not counted:
 * a card carries it both as text and in its blocks.
 */
function captionOccurrences(
  ctx: ScenarioContext,
  channel: string,
  threadTs: string,
  anchor: string,
  needle: string,
): number {
  return threadMessages(ctx, channel, threadTs, anchor)
    .flatMap((message) => (message.blocks ?? []) as { type?: string }[])
    .filter((block) => block.type === "context")
    .map((block) => JSON.stringify(block).split(needle).length - 1)
    .reduce((total, count) => total + count, 0);
}

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

/** Lets `leadId` hold several tasks at once, through agent re-registration. */
async function allowSeveralTasks(ctx: ScenarioContext, leadId: string): Promise<void> {
  const name = ctx.db.get<{ name: string }>("SELECT name FROM agents WHERE id = ?", [leadId])?.name;
  expectStatus(
    await ctx.api("POST", "/api/agents", {
      agentId: leadId,
      body: { name, isLead: true, maxTasks: 3 },
    }),
    [200, 201],
    `let Lead ${leadId} hold several tasks`,
  );
}

/** Ask in channel id `channel`, delegate to a worker, finish both, and claim the Lead's follow-up. */
/**
 * Two Slack users of this scenario only, in turn. Slack inbound takes 10 messages per user per
 * minute (`checkRateLimit` in src/slack/handlers.ts) and drops the next one with no reply. This
 * scenario posts 10 asks in under a minute: as the shared `alice`, the asks of the scenarios
 * before it counted too, and the last ask never became a task.
 */
function askerPool(ctx: ScenarioContext): () => string {
  const ids = ["carol", "dave"].map((name) => ctx.slack.addUser({ name }).id);
  let asks = 0;
  return () => ids[asks++ % ids.length] as string;
}

async function delegatedAsk(
  ctx: ScenarioContext,
  user: string,
  channel: string,
  workerId: string,
  label: string,
  workerResult?: WorkerResult,
): Promise<DelegatedAsk> {
  const message = await ctx.slack.postMessage({
    channel,
    user,
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

  if (workerResult) {
    // store-progress, not the finish route: only it records attachments.
    const workerConn = await ctx.connectMcp(workerId);
    try {
      expectToolOk(
        await callTool(workerConn, "store-progress", {
          taskId: childId,
          status: "completed",
          ...workerResult,
        }),
        `complete the ${label} worker task with deliverables`,
      );
    } finally {
      await workerConn.close();
    }
  } else {
    await finish(ctx, workerId, childId, {
      status: "completed",
      output: `${label} worker result ${ctx.nonce}`,
    });
  }
  const followUpId = await findWorkerFollowUp(ctx, leadId, childId);
  await claim(ctx, leadId, followUpId);
  return { leadId, threadTs: message.ts, askTaskId, followUpId };
}

export const slackLeadFollowUpCard: Scenario = {
  name: "slack-lead-follow-up-card",
  // Band 2 (130-140): render v2 on, delegation off.
  order: 130.5,
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, "e2e-lead-follow-up-card");
    const workerId = await registerWorker(ctx, "e2e-specialist-follow-up-card");
    const asker = askerPool(ctx);

    // 1. The follow-up's output posts once in the ask's thread, with the
    // worker's deliverables under it: worker cards do not post while
    // delegation is off, so this card is the only place people see them. A
    // link the Lead's answer already carries is not repeated.
    const reportUrl = `https://docs.example.test/report-${ctx.nonce}`;
    const prUrl = `https://github.com/example/repo-${ctx.nonce}/pull/42`;
    const quotedUrl = `https://docs.example.test/quoted-${ctx.nonce}`;
    const fileUrl = `https://app.example.test/file/~/org/drive/reports/summary-${ctx.nonce}.md`;
    const videoUrl = `https://cdn.example.test/demo-${ctx.nonce}.mp4`;
    const postedShareUrl = `https://live.agent-fs.dev/share/posted${ctx.nonce}`;
    const pageId = crypto.randomUUID();
    const posted = await delegatedAsk(ctx, asker(), GENERAL, workerId, "posted", {
      output: `posted worker result ${ctx.nonce}: opened ${prUrl}. Notes at ${quotedUrl}. File ${fileUrl}, demo ${videoUrl}, share ${postedShareUrl}`,
      attachments: [
        { kind: "url", url: reportUrl, name: `report ${ctx.nonce}` },
        { kind: "page", pageId, name: "Review notes" },
      ],
    });
    // The Lead cites the worker's PR and attaches the worker's report: each
    // URL still shows once on the card. A bare URL in the answer becomes a
    // short `<url|label>` link; one in a code span stays as written.
    const postedOutput = `follow-up review posted ${ctx.nonce}`;
    const codeUrl = `https://docs.example.test/code-${ctx.nonce}`;
    const leadConn = await ctx.connectMcp(posted.leadId);
    try {
      expectToolOk(
        await callTool(leadConn, "store-progress", {
          taskId: posted.followUpId,
          status: "completed",
          output: `${postedOutput}. Merged the PR [citation:1]. Notes: ${quotedUrl}. Repro: \`${codeUrl}\``,
          citations: [{ index: 1, kind: "url", ref: prUrl, label: "Merged PR" }],
          attachments: [{ kind: "url", url: reportUrl, name: `report ${ctx.nonce}` }],
        }),
        "complete the Lead review with a citation and an attachment",
      );
    } finally {
      await leadConn.close();
    }
    const landed = await pollUntil(
      () => threadMessages(ctx, GENERAL, posted.threadTs, postedOutput).length > 0,
      30_000,
    );
    expect(landed, "The Lead follow-up's outcome card never posted in the ask's thread");
    const deliverables = await pollUntil(
      () =>
        captionOccurrences(ctx, GENERAL, posted.threadTs, postedOutput, reportUrl) === 1 &&
        captionOccurrences(ctx, GENERAL, posted.threadTs, postedOutput, prUrl) === 1,
      15_000,
    );
    expect(
      deliverables,
      `The follow-up card does not list the worker's attachment and output link once each: ${JSON.stringify(threadMessages(ctx, GENERAL, posted.threadTs, postedOutput))}`,
    );
    // Each link is a short label with a type icon under a "Links:" heading.
    for (const needle of [
      `Links: 🌐 <${reportUrl}|report ${ctx.nonce}>`,
      `/pages/${pageId}|Review notes>`,
      "📃 <http",
      `Sources: <${prUrl}|[1]> Merged PR`,
      `📄 <${fileUrl}|summary-${ctx.nonce}.md>`,
      `🎬 <${videoUrl}|demo-${ctx.nonce}.mp4>`,
      `🔗 <${postedShareUrl}|Shared file>`,
    ]) {
      const shown = captionOccurrences(ctx, GENERAL, posted.threadTs, postedOutput, needle);
      expect(
        shown === 1,
        `The follow-up card shows ${JSON.stringify(needle)} ${shown} times, expected 1`,
      );
    }
    // A cited link stays a source: it is not listed again under "Links:".
    const prAsLink = captionOccurrences(ctx, GENERAL, posted.threadTs, postedOutput, "🔀");
    expect(prAsLink === 0, `The cited PR is also listed under "Links:" ${prAsLink} times`);
    const quoted = captionOccurrences(ctx, GENERAL, posted.threadTs, postedOutput, quotedUrl);
    expect(
      quoted === 0,
      `A link already in the Lead's answer is repeated ${quoted} times in captions`,
    );
    const answer = JSON.stringify(
      threadMessages(ctx, GENERAL, posted.threadTs, postedOutput).map((message) => message.text),
    );
    expect(
      answer.includes(`<${quotedUrl}|docs.example.test/quoted-`) &&
        answer.includes(`\`${codeUrl}\``) &&
        !answer.includes(`<${codeUrl}`),
      `The answer does not link its bare URL and keep its code span as written: ${answer}`,
    );
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
      user: asker(),
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
    const replied = await delegatedAsk(ctx, asker(), GENERAL, workerId, "replied");
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

    // 4b. No card either when the Lead, working on its follow-up, replies
    // under another task of the thread. In production the Lead passed the
    // reviewed task's id, so slackReplySent stayed 0 on the follow-up and its
    // card repeated the reply. The worker sends the follow-up as the source
    // task (X-Source-Task-Id), so slack-reply marks the follow-up too.
    const misattributed = await delegatedAsk(ctx, asker(), GENERAL, workerId, "misattributed");
    const misattributedReply = `follow-up reply on the ask task ${ctx.nonce}`;
    const misConn = await ctx.connectMcp(misattributed.leadId, {
      headers: { "X-Source-Task-Id": misattributed.followUpId },
    });
    try {
      expectToolOk(
        await callTool(misConn, "slack-reply", {
          taskId: misattributed.askTaskId,
          message: misattributedReply,
        }),
        "slack-reply under the ask task during the Lead follow-up",
      );
    } finally {
      await misConn.close();
    }
    const sourceMarked = ctx.db.get<{ slackReplySent: number }>(
      "SELECT slackReplySent FROM agent_tasks WHERE id = ?",
      [misattributed.followUpId],
    );
    expect(
      sourceMarked?.slackReplySent === 1,
      "slack-reply did not mark the source follow-up task as replied",
    );
    const misattributedOutput = `follow-up review misattributed ${ctx.nonce}`;
    await finish(ctx, misattributed.leadId, misattributed.followUpId, {
      status: "completed",
      output: misattributedOutput,
    });
    const misattributedPosted = await pollUntil(
      () => threadMessages(ctx, GENERAL, misattributed.threadTs, misattributedOutput).length > 0,
      slackAbsenceWindowMs(ctx),
    );
    expect(
      !misattributedPosted,
      "The Lead follow-up posted a card after a Lead reply under another task",
    );
    const misattributedReplies = threadMessages(
      ctx,
      GENERAL,
      misattributed.threadTs,
      misattributedReply,
    ).length;
    expect(
      misattributedReplies === 1,
      `The Lead's reply under the ask task landed ${misattributedReplies} times, expected 1`,
    );

    // 4c. A reply under an unrelated Lead task of the same thread does not
    // count: the follow-up still posts its card. A person mentions the bot in
    // the thread while the follow-up runs, and the Lead (now allowed several
    // tasks at once) answers that new task with slack-reply.
    const concurrent = await delegatedAsk(ctx, asker(), GENERAL, workerId, "concurrent");
    await allowSeveralTasks(ctx, concurrent.leadId);
    const mention = await ctx.slack.postMessage({
      channel: GENERAL,
      user: asker(),
      thread_ts: concurrent.threadTs,
      text: `<@${ctx.slack.bot.userId}> concurrent: one more question`,
    });
    const otherTask = await findSlackTask(ctx, mention.ts);
    const otherTaskId = String(otherTask.id);
    expect(
      otherTaskId !== concurrent.askTaskId && String(otherTask.agentId) === concurrent.leadId,
      `The thread mention did not create a new Lead task: ${JSON.stringify(otherTask)}`,
    );
    await claim(ctx, concurrent.leadId, otherTaskId);
    const otherReply = `reply to the other question ${ctx.nonce}`;
    const otherConn = await ctx.connectMcp(concurrent.leadId, {
      headers: { "X-Source-Task-Id": otherTaskId },
    });
    try {
      expectToolOk(
        await callTool(otherConn, "slack-reply", { taskId: otherTaskId, message: otherReply }),
        "slack-reply under the concurrent Lead task",
      );
    } finally {
      await otherConn.close();
    }
    const concurrentOutput = `follow-up review concurrent ${ctx.nonce}`;
    await finish(ctx, concurrent.leadId, concurrent.followUpId, {
      status: "completed",
      output: concurrentOutput,
    });
    const concurrentPosted = await pollUntil(
      () => threadMessages(ctx, GENERAL, concurrent.threadTs, concurrentOutput).length > 0,
      30_000,
    );
    expect(
      concurrentPosted,
      "The follow-up card was suppressed by a reply under an unrelated Lead task",
    );
    await finish(ctx, concurrent.leadId, otherTaskId, {
      status: "completed",
      output: `other question answered ${ctx.nonce}`,
    });

    // 4d. Sibling fan-out: one ask, two workers, two Lead follow-ups. Follow-up
    // B answers under the ask; follow-up A has nothing to do with that reply
    // and still posts its card. B's own card is suppressed.
    const fanAsk = await ctx.slack.postMessage({
      channel: GENERAL,
      user: asker(),
      text: `<@${ctx.slack.bot.userId}> fan-out: get two specialists on it`,
    });
    ctx.markThread("lead-follow-up-fan-out", GENERAL, fanAsk.ts);
    const fanAskTask = await findSlackTask(ctx, fanAsk.ts);
    const fanAskId = String(fanAskTask.id);
    const fanLeadId = String(fanAskTask.agentId);
    await allowSeveralTasks(ctx, fanLeadId);
    await claim(ctx, fanLeadId, fanAskId);
    const childA = await createChildTask(ctx, fanAskId, workerId, `fan-out A ${ctx.nonce}`);
    const childB = await createChildTask(ctx, fanAskId, workerId, `fan-out B ${ctx.nonce}`);
    await finish(ctx, fanLeadId, fanAskId, {
      status: "completed",
      output: `fan-out ask answer ${ctx.nonce}`,
    });
    const followUps: string[] = [];
    for (const [label, childId] of [
      ["A", childA],
      ["B", childB],
    ] as const) {
      await claim(ctx, workerId, childId);
      await finish(ctx, workerId, childId, {
        status: "completed",
        output: `fan-out worker ${label} ${ctx.nonce}`,
      });
      followUps.push(await findWorkerFollowUp(ctx, fanLeadId, childId));
    }
    const [followUpA, followUpB] = followUps as [string, string];
    await claim(ctx, fanLeadId, followUpA);
    await claim(ctx, fanLeadId, followUpB);
    const fanReply = `follow-up B reply on the ask ${ctx.nonce}`;
    const fanConn = await ctx.connectMcp(fanLeadId, {
      headers: { "X-Source-Task-Id": followUpB },
    });
    try {
      expectToolOk(
        await callTool(fanConn, "slack-reply", { taskId: fanAskId, message: fanReply }),
        "slack-reply under the ask from follow-up B",
      );
    } finally {
      await fanConn.close();
    }
    const outputB = `follow-up review fan-out B ${ctx.nonce}`;
    await finish(ctx, fanLeadId, followUpB, { status: "completed", output: outputB });
    const outputA = `follow-up review fan-out A ${ctx.nonce}`;
    await finish(ctx, fanLeadId, followUpA, { status: "completed", output: outputA });
    const postedA = await pollUntil(
      () => threadMessages(ctx, GENERAL, fanAsk.ts, outputA).length > 0,
      30_000,
    );
    expect(postedA, "Follow-up A's card was suppressed by follow-up B's reply on the ask");
    const postedB = threadMessages(ctx, GENERAL, fanAsk.ts, outputB).length;
    expect(postedB === 0, "Follow-up B posted a card after its own slack-reply");

    // 5. A Slack Connect channel gets the follow-up card too, like the ask's
    // own card, while SLACK_BLOCK_EXTERNAL_CHANNELS is off (the default).
    // Regression: the follow-up gate refused every Slack Connect channel
    // whatever the flag said and settled the card as abandoned, so a
    // delegated answer never reached the customer thread. The mock always
    // reports channels as internal, so one injected conversations.info answer
    // marks this fresh channel external for any code that asks.
    const externalId = `C0EXT${ctx.nonce.slice(0, 5).toUpperCase()}`;
    const alice = ctx.slack.user("alice").id;
    const externalAsker = asker();
    ctx.slack.addChannel({
      id: externalId,
      name: `ext-${ctx.nonce.toLowerCase()}`,
      members: [alice, externalAsker],
    });
    // Only a public share link the worker made reaches a Slack Connect
    // thread; its app file link and internal attachment do not. A `/share/`
    // path on a host that does not serve agent-fs shares is dropped too:
    // worker output is free text. The SUT leaves AGENT_FS_LIVE_URL unset, so
    // the default live host serves the shares.
    const shareUrl = `https://live.agent-fs.dev/share/tok${ctx.nonce}`;
    const spoofedShareUrl = `https://internal.example.test/share/tok${ctx.nonce}`;
    const appFileUrl = `https://app.example.test/file/~/org/drive/notes-${ctx.nonce}.md`;
    const internalUrl = `https://docs.example.test/internal-${ctx.nonce}`;
    const external = await delegatedAsk(ctx, externalAsker, externalId, workerId, "external", {
      output: `external worker result ${ctx.nonce}: public ${shareUrl}, app ${appFileUrl}, other ${spoofedShareUrl}`,
      attachments: [{ kind: "url", url: internalUrl, name: `internal ${ctx.nonce}` }],
    });
    // A message after the ask's card stops a merge into it: as in production,
    // where the follow-up ended past the merge window, it posts its own card.
    await ctx.slack.postMessage({
      channel: externalId,
      user: "alice",
      thread_ts: external.threadTs,
      text: `<@${ctx.slack.user("bob").id}> side note ${ctx.nonce}`,
    });
    const faultCode = "e2e_ext_shared";
    ctx.slack.injectFault({
      method: "conversations.info",
      error: faultCode,
      extra: { ok: true, channel: { id: externalId, is_ext_shared: true } },
    });
    try {
      const externalOutput = `follow-up review external ${ctx.nonce}`;
      await finish(ctx, external.leadId, external.followUpId, {
        status: "completed",
        output: externalOutput,
      });
      const delivered = await pollUntil(
        () => threadMessages(ctx, externalId, external.threadTs, externalOutput).length > 0,
        30_000,
      );
      expect(delivered, "The Lead follow-up's card never reached the Slack Connect thread");
      await expectFinalizedCard(ctx, external.followUpId, external.threadTs, "external follow-up");
      const count = (url: string) =>
        captionOccurrences(ctx, externalId, external.threadTs, externalOutput, url);
      expect(
        count(shareUrl) === 1 &&
          count(appFileUrl) === 0 &&
          count(internalUrl) === 0 &&
          count(spoofedShareUrl) === 0,
        `The Slack Connect card must list only the share link: share=${count(shareUrl)} app=${count(appFileUrl)} internal=${count(internalUrl)} spoofed=${count(spoofedShareUrl)}`,
      );
      const shareLabel = `Links: 🔗 <${shareUrl}|Shared file>`;
      expect(
        count(shareLabel) === 1,
        `The Slack Connect card does not label the share link as ${JSON.stringify(shareLabel)}`,
      );
      const card = ctx.db.get<{ ts: string; delivery_abandoned_at: string | null }>(
        "SELECT ts, delivery_abandoned_at FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
        [external.followUpId],
      );
      expect(
        card !== null &&
          !card.ts.startsWith("pending:") &&
          !card.ts.startsWith("merged:") &&
          card.delivery_abandoned_at === null,
        `The external follow-up's card is not its own delivered message: ${JSON.stringify(card)}`,
      );
    } finally {
      // With the flag off nothing asks Slack about the channel, so the fault
      // may still be armed. Spend it here: it answers for any channel.
      const spent = () =>
        ctx.slack.apiCalls("conversations.info").some((call) => call.error === faultCode);
      if (!spent()) {
        await fetch(`${ctx.slack.apiUrl}conversations.info`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ctx.slack.bot.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel: externalId }),
        });
      }
      expect(spent(), "The injected conversations.info answer is still armed");
    }

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
    const recovered = await delegatedAsk(ctx, asker(), GENERAL, workerId, "recovered");
    await failDelivery(recovered, recoveredOutput);
    const suppressed = await delegatedAsk(ctx, asker(), GENERAL, workerId, "suppressed");
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
