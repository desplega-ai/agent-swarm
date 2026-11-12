import type { SlackMessage } from "@desplega.ai/slack-mock";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolOk } from "./platformb-helpers";
import {
  ask,
  claim,
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
): Promise<string> {
  const response = await ctx.api("POST", "/api/tasks", {
    body: {
      task: text,
      parentTaskId,
      requestedByUserId: userId,
      agentId: leadId,
      routingReason: "continuity",
      source: "ui",
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

function slackTaskCount(ctx: ScenarioContext): number {
  return (
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE source = 'slack'")?.n ??
    0
  );
}

export const slackSessionMirror: Scenario = {
  name: "slack-session-mirror",
  order: 92,
  async run(ctx) {
    const leadId = await registerLead(ctx, `e2e-lead-session-mirror-${ctx.nonce}`);
    const first = await ask(ctx, `session mirror root ${ctx.nonce}`);
    ctx.markThread("session-mirror", CHANNEL, first.ts);
    await waitForEyes(ctx, first.ts);
    const rootTaskId = String((await findSlackTask(ctx, first.ts)).id);
    await claim(ctx, leadId, rootTaskId);
    await finish(ctx, leadId, rootTaskId, { status: "completed", output: "Root answer." });
    await waitForOutcome(ctx, first.ts, "Root answer.");

    // The person behind the dashboard, linked to Alice's Slack account for the avatar.
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

    try {
      // both: the prompt with the person's persona, then the reply card.
      await setMirrorMode(ctx, "both");
      const messageEventsBefore = ctx.slack.deliveries("message").length;
      const slackTasksBefore = slackTaskCount(ctx);
      const promptText = `mirror both prompt <@${ctx.slack.bot.userId}> ${ctx.nonce}`;
      const bothId = await sessionFollowUp(ctx, rootTaskId, userId, leadId, promptText);
      const prompt = await waitForThreadMessage(ctx, first.ts, `mirror both prompt`);
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
        () => ctx.slack.deliveries("message").slice(messageEventsBefore).some((d) => d.acked),
        15_000,
      );
      expect(delivered, "Slack never delivered the mirrored prompt back to the app");
      await new Promise((resolve) => setTimeout(resolve, slackAbsenceWindowMs(ctx)));
      expect(
        slackTaskCount(ctx) === slackTasksBefore,
        `The mirrored prompt ${prompt.ts} created a Slack task`,
      );
      expect(
        !ctx.slack
          .apiCalls("reactions.add")
          .some((c) => c.args.timestamp === prompt.ts),
        `The mirrored prompt ${prompt.ts} got an intake reaction`,
      );

      await claim(ctx, leadId, bothId);
      const bothOutput = `mirror both reply ${ctx.nonce}`;
      await finish(ctx, leadId, bothId, { status: "completed", output: bothOutput });
      await waitForThreadMessage(ctx, first.ts, bothOutput);

      // No double post: the agent replied in the thread itself, so no card.
      const repliedId = await sessionFollowUp(
        ctx,
        bothId,
        userId,
        leadId,
        `mirror replied prompt ${ctx.nonce}`,
      );
      await waitForThreadMessage(ctx, first.ts, "mirror replied prompt");
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
      await waitForOutcomeAbsence(ctx, first.ts, repliedOutput);
      expect(
        threadMessages(ctx, first.ts, "mirror agent reply").length === 1,
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
      await waitForThreadMessage(ctx, first.ts, replyOutput);
      await waitForOutcomeAbsence(ctx, first.ts, "mirror reply-mode prompt");

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
      await waitForOutcomeAbsence(ctx, first.ts, "mirror off prompt");
      await waitForOutcomeAbsence(ctx, first.ts, offOutput);
    } finally {
      await setMirrorMode(ctx, "both");
    }
  },
};
