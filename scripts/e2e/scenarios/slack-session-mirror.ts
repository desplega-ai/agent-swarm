import type { SlackMessage } from "@desplega.ai/slack-mock";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolOk } from "./platformb-helpers";
import {
  ask,
  claim,
  enableSlackDelegation,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  slackAbsenceWindowMs,
  waitForEyes,
  waitForOutcome,
  waitForOutcomeAbsence,
} from "./slack-helpers";

const CHANNEL = "C0GENERAL0";
const AVATAR = "https://avatars.example/alice-72.png";

async function setMirrorMode(ctx: ScenarioContext, value: "off" | "reply" | "both") {
  expectStatus(
    await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key: "SLACK_SESSION_MIRROR", value, isSecret: false },
    }),
    [200],
    `set SLACK_SESSION_MIRROR=${value}`,
  );
  // The global config reload that updates process.env is debounced (~250 ms).
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

/** A follow-up as the Sessions composer sends it: source "ui", the person, the parent. */
async function sessionFollowUp(
  ctx: ScenarioContext,
  parentTaskId: string,
  userId: string,
  leadId: string,
  text: string,
  draft = false,
): Promise<string> {
  const response = await ctx.api("POST", "/api/tasks", {
    body: {
      task: text,
      parentTaskId,
      requestedByUserId: userId,
      agentId: leadId,
      routingReason: "continuity",
      source: "ui",
      ...(draft ? { draft: true } : {}),
    },
  });
  expectStatus(response, [201], `Sessions follow-up "${text}"`);
  const task = asRecord(response.json);
  expect(
    task.slackChannelId === CHANNEL,
    `Follow-up ${String(task.id)} did not inherit the Slack thread`,
  );
  return asString(task.id, "follow-up id");
}

function threadMessages(ctx: ScenarioContext, threadTs: string, needle: string): SlackMessage[] {
  return ctx.slack
    .messages("general")
    .filter((m) => m.thread_ts === threadTs && JSON.stringify(m).includes(needle));
}

async function waitForThreadMessage(
  ctx: ScenarioContext,
  threadTs: string,
  needle: string,
): Promise<SlackMessage> {
  let found: SlackMessage | undefined;
  const ok = await pollUntil(() => {
    found = threadMessages(ctx, threadTs, needle)[0];
    return found !== undefined;
  }, 30_000);
  expect(ok && found, `"${needle}" never reached ${CHANNEL} thread ${threadTs}`);
  return found;
}

/** Waits for `needle`, lets several watcher ticks pass, then asserts it posted exactly once. */
async function expectPostedOnce(
  ctx: ScenarioContext,
  threadTs: string,
  needle: string,
): Promise<void> {
  await waitForThreadMessage(ctx, threadTs, needle);
  await new Promise((resolve) => setTimeout(resolve, slackAbsenceWindowMs(ctx)));
  const copies = threadMessages(ctx, threadTs, needle).length;
  expect(copies === 1, `"${needle}" posted ${copies} times in thread ${threadTs}`);
}

async function cancelTask(ctx: ScenarioContext, taskId: string, reason: string): Promise<void> {
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: { reason } }),
    [200],
    `cancel ${taskId}`,
  );
}

/**
 * A finished Slack root plus the dashboard person behind the follow-ups,
 * linked to Alice's Slack account for the avatar.
 */
async function startMirroredSession(ctx: ScenarioContext, label: string) {
  // Reuse a live lead: an extra one sorts ahead in lead routing and takes later
  // scenarios' asks away from the leads they registered.
  const liveLeads =
    ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agents WHERE isLead = 1 AND status != 'offline'",
    )?.n ?? 0;
  if (liveLeads === 0) await registerLead(ctx, `e2e-lead-${label}-${ctx.nonce}`);
  const { ts: threadTs } = await ask(ctx, `${label} root ${ctx.nonce}`);
  ctx.markThread(label, CHANNEL, threadTs);
  await waitForEyes(ctx, threadTs);
  const root = await findSlackTask(ctx, threadTs);
  const rootTaskId = String(root.id);
  // Several leads may exist by now; the ask names the one that owns it.
  const leadId = String(root.agentId);
  await claim(ctx, leadId, rootTaskId);
  await finish(ctx, leadId, rootTaskId, { status: "completed", output: `${label} root answer.` });
  await waitForOutcome(ctx, threadTs, `${label} root answer.`);

  // The mock's profiles carry no image, so give Alice one.
  const alice = ctx.slack.user("alice");
  (alice.profile as Record<string, unknown>).image_72 = AVATAR;
  let userId = (
    ctx.db.get<{ userId: string }>(
      "SELECT userId FROM user_external_ids WHERE kind = 'slack' AND externalId = ?",
      [alice.id],
    ) ?? undefined
  )?.userId;
  if (!userId) {
    const created = await ctx.api("POST", "/api/users", {
      body: {
        name: `Mirror Alice ${ctx.nonce}`,
        identities: [{ kind: "slack", externalId: alice.id }],
      },
    });
    expectStatus(created, [200], "create the Sessions person");
    userId = asString(asRecord(asRecord(created.json).user).id, "user id");
  }
  return { leadId, threadTs, rootTaskId, userId };
}

/**
 * Drops the Slack link of the person this file created. Later scenarios in the
 * same process (Chat SDK commands) resolve Alice to a user only when one is linked.
 */
async function unlinkMirrorPerson(ctx: ScenarioContext): Promise<void> {
  const alice = ctx.slack.user("alice");
  const row = ctx.db.get<{ userId: string }>(
    `SELECT e.userId FROM user_external_ids e JOIN users u ON u.id = e.userId
      WHERE e.kind = 'slack' AND e.externalId = ? AND u.name LIKE 'Mirror Alice %'`,
    [alice.id],
  );
  if (!row) return;
  expectStatus(
    await ctx.api("DELETE", `/api/users/${row.userId}/identities/slack/${alice.id}`),
    [200, 204],
    "unlink the Sessions person from Alice",
  );
}

/** Runs a scenario body, then unlinks the person it created even when the body fails. */
function withMirrorPerson(body: (ctx: ScenarioContext) => Promise<void>) {
  return async (ctx: ScenarioContext): Promise<void> => {
    try {
      await body(ctx);
    } finally {
      await unlinkMirrorPerson(ctx);
    }
  };
}

/** One completed follow-up in the current renderer mode gets exactly one reply card. */
async function expectOneReplyCard(ctx: ScenarioContext, label: string): Promise<void> {
  const { leadId, threadTs, rootTaskId, userId } = await startMirroredSession(ctx, label);
  await setMirrorMode(ctx, "both");
  const followUpId = await sessionFollowUp(
    ctx,
    rootTaskId,
    userId,
    leadId,
    `${label} prompt ${ctx.nonce}`,
  );
  await claim(ctx, leadId, followUpId);
  const output = `${label} output ${ctx.nonce}`;
  await finish(ctx, leadId, followUpId, { status: "completed", output });
  await expectPostedOnce(ctx, threadTs, output);
}

function slackTaskCount(ctx: ScenarioContext): number {
  return (
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE source = 'slack'")?.n ??
    0
  );
}

export const slackSessionMirror: Scenario = {
  name: "slack-session-mirror",
  order: 92,
  run: withMirrorPerson(async (ctx) => {
    // Legacy renderer: the e2e server starts with SLACK_RENDER_V2=false.
    const { leadId, threadTs, rootTaskId, userId } = await startMirroredSession(
      ctx,
      "session-mirror",
    );

    try {
      // both: the prompt with the person's persona, then the reply card.
      await setMirrorMode(ctx, "both");
      const messageEventsBefore = ctx.slack.deliveries("message").length;
      const slackTasksBefore = slackTaskCount(ctx);
      const promptText = `mirror both prompt <@${ctx.slack.bot.userId}> ${ctx.nonce}`;
      const bothId = await sessionFollowUp(ctx, rootTaskId, userId, leadId, promptText);
      const prompt = await waitForThreadMessage(ctx, threadTs, `mirror both prompt`);
      const call = ctx.slack
        .apiCalls("chat.postMessage")
        .find((c) => String(c.args.text ?? "").includes("mirror both prompt"));
      expect(call, "No chat.postMessage call for the mirrored prompt");
      ctx.log(`mirrored prompt payload: ${JSON.stringify(call.args)}`);
      expect(call.args.username === "alice", `Prompt username is ${String(call.args.username)}`);
      expect(call.args.icon_url === AVATAR, `Prompt icon_url is ${String(call.args.icon_url)}`);
      const payload = JSON.stringify(call.args);
      expect(
        payload.includes(`/sessions/${rootTaskId}|Sessions>`),
        "Prompt has no Sent from Sessions link to the session root",
      );
      expect(
        payload.includes("&lt;@") && !String(call.args.text).includes(`<@${ctx.slack.bot.userId}>`),
        "Prompt kept a live @-mention of the bot",
      );

      // Our own post must not start a task: Slack delivers it back, the handler ignores it.
      const delivered = await pollUntil(
        () =>
          ctx.slack
            .deliveries("message")
            .slice(messageEventsBefore)
            .some((d) => d.acked),
        15_000,
      );
      expect(delivered, "Slack never delivered the mirrored prompt back to the app");
      await new Promise((resolve) => setTimeout(resolve, slackAbsenceWindowMs(ctx)));
      expect(
        slackTaskCount(ctx) === slackTasksBefore,
        `The mirrored prompt ${prompt.ts} created a Slack task`,
      );
      expect(
        !ctx.slack.apiCalls("reactions.add").some((c) => c.args.timestamp === prompt.ts),
        `The mirrored prompt ${prompt.ts} got an intake reaction`,
      );

      await claim(ctx, leadId, bothId);
      const bothOutput = `mirror both reply ${ctx.nonce}`;
      await finish(ctx, leadId, bothId, { status: "completed", output: bothOutput });
      await expectPostedOnce(ctx, threadTs, bothOutput);

      // A draft withdrawn before promotion (the composer cancels it when its
      // attachment upload fails) was never sent: no prompt, no cancellation card.
      const withdrawnId = await sessionFollowUp(
        ctx,
        bothId,
        userId,
        leadId,
        `mirror withdrawn draft ${ctx.nonce}`,
        true,
      );
      await cancelTask(
        ctx,
        withdrawnId,
        "Attachment upload failed; the message stays in the composer.",
      );
      await waitForOutcomeAbsence(ctx, threadTs, withdrawnId);
      expect(
        threadMessages(ctx, threadTs, "mirror withdrawn draft").length === 0,
        "The withdrawn draft's prompt reached Slack",
      );

      // A promoted draft was sent, so its cancellation still mirrors, once.
      const sentDraftId = await sessionFollowUp(
        ctx,
        bothId,
        userId,
        leadId,
        `mirror sent draft ${ctx.nonce}`,
        true,
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${sentDraftId}/promote-draft`),
        [200],
        "promote the sent draft",
      );
      await waitForThreadMessage(ctx, threadTs, "mirror sent draft");
      await cancelTask(ctx, sentDraftId, "Cancelled from Sessions");
      await expectPostedOnce(ctx, threadTs, sentDraftId);

      // No double post: the agent replied in the thread itself, so no card.
      const repliedId = await sessionFollowUp(
        ctx,
        bothId,
        userId,
        leadId,
        `mirror replied prompt ${ctx.nonce}`,
      );
      await waitForThreadMessage(ctx, threadTs, "mirror replied prompt");
      await claim(ctx, leadId, repliedId);
      const conn = await ctx.connectMcp(leadId);
      try {
        expectToolOk(
          await callTool(conn, "slack-reply", {
            taskId: repliedId,
            message: `mirror agent reply ${ctx.nonce}`,
          }),
          "slack-reply in the follow-up",
        );
      } finally {
        await conn.close();
      }
      const repliedOutput = `mirror replied output ${ctx.nonce}`;
      await finish(ctx, leadId, repliedId, { status: "completed", output: repliedOutput });
      await waitForOutcomeAbsence(ctx, threadTs, repliedOutput);
      expect(
        threadMessages(ctx, threadTs, "mirror agent reply").length === 1,
        "The agent's slack-reply did not land exactly once",
      );

      // reply: only the card.
      await setMirrorMode(ctx, "reply");
      const replyId = await sessionFollowUp(
        ctx,
        repliedId,
        userId,
        leadId,
        `mirror reply-mode prompt ${ctx.nonce}`,
      );
      await claim(ctx, leadId, replyId);
      const replyOutput = `mirror reply-mode output ${ctx.nonce}`;
      await finish(ctx, leadId, replyId, { status: "completed", output: replyOutput });
      await waitForThreadMessage(ctx, threadTs, replyOutput);
      await waitForOutcomeAbsence(ctx, threadTs, "mirror reply-mode prompt");

      // off: neither.
      await setMirrorMode(ctx, "off");
      const offId = await sessionFollowUp(
        ctx,
        replyId,
        userId,
        leadId,
        `mirror off prompt ${ctx.nonce}`,
      );
      await claim(ctx, leadId, offId);
      const offOutput = `mirror off output ${ctx.nonce}`;
      await finish(ctx, leadId, offId, { status: "completed", output: offOutput });
      await waitForOutcomeAbsence(ctx, threadTs, "mirror off prompt");
      await waitForOutcomeAbsence(ctx, threadTs, offOutput);
    } finally {
      await setMirrorMode(ctx, "both");
    }
  }),
};

/** Render v2 with delegation off: the mirror still owns the follow-up's reply card. */
export const slackSessionMirrorRenderV2: Scenario = {
  name: "slack-session-mirror-render-v2",
  // Shard 2 (130-140) runs with SLACK_RENDER_V2 on and delegation off.
  order: 139.5,
  run: withMirrorPerson(async (ctx) => {
    await enableSlackRenderV2Only(ctx);
    await expectOneReplyCard(ctx, "session-mirror-v2");
  }),
};

/**
 * Render v2 with delegation on: the delegation pass posts the follow-up's child
 * card and the mirror stands down, so the thread still gets one card, and none
 * when the agent replied in the thread itself.
 */
export const slackSessionMirrorDelegation: Scenario = {
  name: "slack-session-mirror-delegation",
  order: 145,
  run: withMirrorPerson(async (ctx) => {
    await enableSlackDelegation(ctx);
    await expectOneReplyCard(ctx, "session-mirror-delegation");

    const { leadId, threadTs, rootTaskId, userId } = await startMirroredSession(
      ctx,
      "session-mirror-delegation-replied",
    );
    const repliedId = await sessionFollowUp(
      ctx,
      rootTaskId,
      userId,
      leadId,
      `delegation replied prompt ${ctx.nonce}`,
    );
    await claim(ctx, leadId, repliedId);
    const conn = await ctx.connectMcp(leadId);
    try {
      expectToolOk(
        await callTool(conn, "slack-reply", {
          taskId: repliedId,
          message: `delegation agent reply ${ctx.nonce}`,
        }),
        "slack-reply in the follow-up",
      );
    } finally {
      await conn.close();
    }
    const repliedOutput = `delegation replied output ${ctx.nonce}`;
    await finish(ctx, leadId, repliedId, { status: "completed", output: repliedOutput });
    await waitForOutcomeAbsence(ctx, threadTs, repliedOutput);
    expect(
      threadMessages(ctx, threadTs, "delegation agent reply").length === 1,
      "The agent's slack-reply did not land exactly once",
    );
  }),
};
