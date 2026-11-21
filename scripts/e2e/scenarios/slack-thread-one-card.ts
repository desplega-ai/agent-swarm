import type { SlackMessage } from "@desplega.ai/slack-mock";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
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
  waitForEyes,
  waitForOutcome,
} from "./slack-helpers";

// One fix, end to end, in one thread: a Slack ask, a Sessions follow-up that
// sends a coder, and a reviewer the coder starts. Each worker's completion
// gets a Lead follow-up. The thread shows:
// - one live card for both follow-ups: the reviewer's follow-up replaces the
//   coder's answer in the coder follow-up's card, with no time limit,
// - "PR <url>" as "PR #42", and a review link into a PR the card already
//   shows is not listed again under "Links:",
// - the footers main renders: `Ns · lead · <follow-up task>` on the card and
//   `lead · <task>` on the mirrored Sessions reply, with no worker names;
//   the card footer links only the newest follow-up, the answer it shows,
// - no footer anywhere with SLACK_REPLY_FOOTER_ENABLED=false.
//
// Runs with render v2 on, delegation and the task tree off: the production state.

const CHANNEL = "C0GENERAL0";
const REPO = "https://github.com/example/app";

type ThreadRun = {
  threadTs: string;
  sessionTaskId: string;
  coderTaskId: string;
  reviewerTaskId: string;
  coderName: string;
  reviewerName: string;
  leadName: string;
  /** Text from each follow-up's answer that has no URL, so linkifying leaves it as written. */
  coderFollowUpNeedle: string;
  reviewerFollowUpNeedle: string;
  sessionOutput: string;
  coderFollowUpId: string;
  reviewerFollowUpId: string;
};

function threadMessages(ctx: ScenarioContext, threadTs: string): SlackMessage[] {
  return ctx.slack.messages("general").filter((message) => message.thread_ts === threadTs);
}

function carriers(ctx: ScenarioContext, threadTs: string, needle: string): SlackMessage[] {
  return threadMessages(ctx, threadTs).filter((message) =>
    JSON.stringify(message).includes(needle),
  );
}

function outcomeRow(ctx: ScenarioContext, taskId: string) {
  return ctx.db.get<{ id: string; ts: string; finalized_at: string | null; merged_into_id: string | null }>(
    "SELECT id, ts, finalized_at, merged_into_id FROM slack_messages WHERE kind = 'outcome' AND task_id = ?",
    [taskId],
  );
}

/** The `context` block texts of a message: its captions and footer. */
function contextTexts(message: SlackMessage | undefined): string[] {
  const blocks = (message?.blocks ?? []) as Array<{
    type?: string;
    elements?: Array<{ text?: string }>;
  }>;
  return blocks
    .filter((block) => block.type === "context")
    .map((block) => (block.elements ?? []).map((element) => element.text ?? "").join(" "));
}

/** A dashboard person linked to Alice, so a Sessions follow-up mirrors under her name. */
async function sessionPerson(ctx: ScenarioContext): Promise<string> {
  const alice = ctx.slack.user("alice");
  const linked = ctx.db.get<{ userId: string }>(
    "SELECT userId FROM user_external_ids WHERE kind = 'slack' AND externalId = ?",
    [alice.id],
  );
  if (linked) return linked.userId;
  const created = await ctx.api("POST", "/api/users", {
    body: { name: `Thread Alice ${ctx.nonce}`, identities: [{ kind: "slack", externalId: alice.id }] },
  });
  expectStatus(created, [200], "create the Sessions person");
  return asString(asRecord(asRecord(created.json).user).id, "user id");
}

/** Drops the Slack link this file made: later scenarios resolve Alice to a user only when one is linked. */
async function unlinkSessionPerson(ctx: ScenarioContext): Promise<void> {
  const alice = ctx.slack.user("alice");
  const row = ctx.db.get<{ userId: string }>(
    `SELECT e.userId FROM user_external_ids e JOIN users u ON u.id = e.userId
      WHERE e.kind = 'slack' AND e.externalId = ? AND u.name LIKE 'Thread Alice %'`,
    [alice.id],
  );
  if (!row) return;
  expectStatus(
    await ctx.api("DELETE", `/api/users/${row.userId}/identities/slack/${alice.id}`),
    [200, 204],
    "unlink the Sessions person from Alice",
  );
}

/** Waits until the task's outcome row is finalized. */
async function settled(ctx: ScenarioContext, taskId: string, what: string): Promise<void> {
  const done = await pollUntil(() => outcomeRow(ctx, taskId)?.finalized_at != null, 30_000);
  expect(done, `The ${what} card never finalized: ${JSON.stringify(outcomeRow(ctx, taskId))}`);
}

/** Plays the thread: ask, Sessions follow-up, coder, reviewer, and both Lead follow-ups. */
async function playThread(ctx: ScenarioContext, label: string): Promise<ThreadRun> {
  // Reuse a live lead: an extra one sorts ahead in lead routing and takes later
  // scenarios' asks away from the leads they registered.
  const liveLeads =
    ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agents WHERE isLead = 1 AND status != 'offline'",
    )?.n ?? 0;
  if (liveLeads === 0) await registerLead(ctx, `e2e-lead-${label}`);
  const coderName = `coder-${label}`;
  const reviewerName = `reviewer-${label}`;
  const coderId = await registerWorker(ctx, coderName);
  const reviewerId = await registerWorker(ctx, reviewerName);
  const userId = await sessionPerson(ctx);
  const pr = `${REPO}/pull/42`;

  const root = await ctx.slack.postMessage({
    channel: CHANNEL,
    user: "alice",
    text: `<@${ctx.slack.bot.userId}> what is this deploy failure email? ${label}`,
  });
  ctx.markThread(label, CHANNEL, root.ts);
  await waitForEyes(ctx, root.ts);
  const ask = await findSlackTask(ctx, root.ts);
  const askId = String(ask.id);
  const leadId = String(ask.agentId);
  const leadName =
    ctx.db.get<{ name: string }>("SELECT name FROM agents WHERE id = ?", [leadId])?.name ?? "";
  await claim(ctx, leadId, askId);
  const askOutput = `Production deploys fail on a missing env var. Want me to send a worker? ${ctx.nonce}`;
  await finish(ctx, leadId, askId, { status: "completed", output: askOutput });
  await waitForOutcome(ctx, root.ts, askOutput);

  // The person answers from Sessions: the prompt and the Lead's reply are mirrored.
  const created = await ctx.api("POST", "/api/tasks", {
    body: {
      task: `yes please fix it ${label} ${ctx.nonce}`,
      parentTaskId: askId,
      requestedByUserId: userId,
      agentId: leadId,
      routingReason: "continuity",
      source: "ui",
    },
  });
  expectStatus(created, [201], "Sessions follow-up");
  const sessionTaskId = asString(asRecord(created.json).id, "Sessions follow-up id");
  await waitForOutcome(ctx, root.ts, `yes please fix it ${label}`);
  await claim(ctx, leadId, sessionTaskId);
  const coderTaskId = await createChildTask(ctx, sessionTaskId, coderId, `fix the deploy ${label}`);
  const sessionOutput = `${coderName} is on it. ${ctx.nonce}`;
  await finish(ctx, leadId, sessionTaskId, { status: "completed", output: sessionOutput });
  await waitForOutcome(ctx, root.ts, sessionOutput);

  // The coder opens the PR and starts its own reviewer.
  await claim(ctx, coderId, coderTaskId);
  const reviewerTaskId = await createChildTask(ctx, coderTaskId, reviewerId, `review ${pr}`);
  await finish(ctx, coderId, coderTaskId, {
    status: "completed",
    output: `Root cause: the env var was renamed. Fix PR ${pr}. ${ctx.nonce}`,
  });
  const coderFollowUpId = await findWorkerFollowUp(ctx, leadId, coderTaskId);
  await claim(ctx, leadId, coderFollowUpId);
  const coderFollowUpNeedle = `is all green ${ctx.nonce}`;
  await finish(ctx, leadId, coderFollowUpId, {
    status: "completed",
    output: `Fix PR ${pr} ${coderFollowUpNeedle}. ${reviewerName} is checking it.`,
  });
  await settled(ctx, coderFollowUpId, "coder follow-up");

  await claim(ctx, reviewerId, reviewerTaskId);
  await finish(ctx, reviewerId, reviewerTaskId, {
    status: "completed",
    output: `Approved ${pr}#pullrequestreview-6005538616. Preview: https://vercel.example.test/app/preview-${ctx.nonce}`,
  });
  const reviewerFollowUpId = await findWorkerFollowUp(ctx, leadId, reviewerTaskId);
  await claim(ctx, leadId, reviewerFollowUpId);
  const reviewerFollowUpNeedle = `Fix ready to merge ${ctx.nonce}`;
  await finish(ctx, leadId, reviewerFollowUpId, {
    status: "completed",
    output: `${reviewerFollowUpNeedle}: PR ${pr} is approved and green.`,
  });
  await settled(ctx, reviewerFollowUpId, "reviewer follow-up");
  // Names each task id in the log, for reading the thread's footers.
  ctx.log(
    `${label} tasks: ${JSON.stringify({ ask: askId, session: sessionTaskId, coder: coderTaskId, reviewer: reviewerTaskId, coderFollowUp: coderFollowUpId, reviewerFollowUp: reviewerFollowUpId })}`,
  );
  return {
    threadTs: root.ts,
    sessionTaskId,
    coderTaskId,
    reviewerTaskId,
    coderName,
    reviewerName,
    leadName,
    coderFollowUpNeedle,
    reviewerFollowUpNeedle,
    sessionOutput,
    coderFollowUpId,
    reviewerFollowUpId,
  };
}

/** One live card for both follow-ups, and the PR labels, with either footer setting. */
async function expectOneCard(ctx: ScenarioContext, run: ThreadRun): Promise<SlackMessage> {
  const host = outcomeRow(ctx, run.coderFollowUpId);
  const merged = outcomeRow(ctx, run.reviewerFollowUpId);
  expect(
    !!host && merged?.merged_into_id === host.id,
    `The reviewer follow-up did not merge into the coder follow-up's card: ${JSON.stringify({ host, merged })}`,
  );
  const shown = await pollUntil(
    () =>
      carriers(ctx, run.threadTs, run.reviewerFollowUpNeedle).length === 1 &&
      carriers(ctx, run.threadTs, run.coderFollowUpNeedle).length === 0,
    15_000,
  );
  const card = carriers(ctx, run.threadTs, run.reviewerFollowUpNeedle)[0];
  expect(
    shown && card?.ts === host?.ts,
    `The newest follow-up did not replace the older one in one card: ${JSON.stringify(threadMessages(ctx, run.threadTs).map((m) => m.text))}`,
  );
  const body = JSON.stringify(threadMessages(ctx, run.threadTs));
  expect(!/PR <[^|>]+\|PR #42/.test(body), `A card reads "PR PR #42": ${body}`);
  expect(body.includes(`PR <${REPO}/pull/42|#42>`), `No "PR #42" link in the thread: ${body}`);
  const links = contextTexts(card).filter((text) => text.startsWith("Links:"));
  expect(
    links.length === 1 && links[0]?.includes("vercel.example.test") && !links[0]?.includes("#42"),
    `The card's Links row repeats the PR or misses the preview: ${JSON.stringify(links)}`,
  );
  return card as SlackMessage;
}

export const slackThreadOneCard: Scenario = {
  name: "slack-thread-one-card",
  // Band 2 (130-140): render v2 on, delegation off.
  order: 130.7,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    const noTree = { SLACK_RENDER_V2_TASK_TREE_ENABLED: "false" };
    try {
      await ctx.restartSut({ env: noTree });
      const on = await playThread(ctx, "thread-footer-on");
      const card = await expectOneCard(ctx, on);
      // The footers stay as main renders them: no worker credit.
      const noWorkerCredit = (text: string) =>
        !text.includes(on.coderName) &&
        !text.includes(on.reviewerName) &&
        !text.includes("→") &&
        !/\bworkers?\b/.test(text) &&
        !text.includes(on.coderTaskId.slice(0, 8)) &&
        !text.includes(on.reviewerTaskId.slice(0, 8));
      const footer = contextTexts(card).at(-1) ?? "";
      expect(
        /^\d+[hms]\S* · /.test(footer) &&
          footer.split(" · ")[1] === on.leadName &&
          !footer.includes(on.coderFollowUpId.slice(0, 8)) &&
          footer.includes(on.reviewerFollowUpId.slice(0, 8)) &&
          noWorkerCredit(footer),
        `The card footer is not main's "time · lead · tasks" line: ${footer}`,
      );
      const reply = carriers(ctx, on.threadTs, on.sessionOutput)[0];
      const replyFooter = contextTexts(reply).at(-1) ?? "";
      expect(
        replyFooter.startsWith(`${on.leadName} · `) &&
          replyFooter.includes(on.sessionTaskId.slice(0, 8)) &&
          noWorkerCredit(replyFooter),
        `The mirrored Sessions reply footer is not main's "lead · task" line: ${JSON.stringify(reply?.blocks)}`,
      );

      await ctx.restartSut({ env: { ...noTree, SLACK_REPLY_FOOTER_ENABLED: "false" } });
      const off = await playThread(ctx, "thread-footer-off");
      await expectOneCard(ctx, off);
      const ids = [
        off.sessionTaskId,
        off.coderTaskId,
        off.reviewerTaskId,
        off.coderFollowUpId,
        off.reviewerFollowUpId,
      ];
      // The task tree lists task links by design: it is not a footer.
      const trees = new Set(
        ctx.db
          .query<{ ts: string }>(
            "SELECT ts FROM slack_messages WHERE kind = 'tree' AND thread_ts = ?",
            [off.threadTs],
          )
          .map((row) => row.ts),
      );
      const answers = threadMessages(ctx, off.threadTs).filter((message) => !trees.has(message.ts));
      expect(answers.length >= 3, `The footer-off thread has too few messages: ${answers.length}`);
      for (const message of answers) {
        const footers = contextTexts(message).filter((text) =>
          ids.some((id) => text.includes(id.slice(0, 8))),
        );
        expect(
          footers.length === 0,
          `Message ${message.ts} has a footer with the footer setting off: ${JSON.stringify(footers)}`,
        );
      }
    } finally {
      await ctx.restartSut();
      await unlinkSessionPerson(ctx);
    }
  },
};
