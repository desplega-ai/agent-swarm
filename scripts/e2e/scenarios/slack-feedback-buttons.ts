import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolOk } from "./platformb-helpers";
import {
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  registerLead,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

const CHANNEL = "C0GENERAL0";
const NAMESPACE = "slack-feedback";

/** Ask, complete the task (with `uiSpec` as its card, when given), and return its outcome card. */
async function answer(ctx: ScenarioContext, label: string, uiSpec?: Record<string, unknown>) {
  const ask = await ctx.slack.postMessage({
    channel: "general",
    user: "bob",
    text: `<@${ctx.slack.bot.userId}> summarize the release`,
  });
  ctx.markThread(label, CHANNEL, ask.ts);
  await waitForEyes(ctx, ask.ts);
  const task = await findSlackTask(ctx, ask.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claim(ctx, leadId, taskId);
  const summary = "Release checks passed.";
  const mcp = await ctx.connectMcp(leadId);
  try {
    expectToolOk(
      await callTool(mcp, "store-progress", {
        taskId,
        status: "completed",
        output: summary,
        ...(uiSpec ? { uiSpec } : {}),
      }),
      "Complete the Slack task",
    );
  } finally {
    await mcp.close();
  }
  const outcome = await waitForOutcome(ctx, ask.ts, summary);
  const stopped = await ctx.slack.waitForApiCall("chat.stopStream", {
    timeoutMs: 30_000,
    // ok: a stop Slack refused (the fallback test below) is retried, so wait for the one that landed.
    where: (call) => call.ok && call.args.ts === outcome.ts && call.args.channel === CHANNEL,
  });
  expect(stopped.ok, "The outcome did not finish streaming");
  await waitForReaction(ctx, ask.ts, "white_check_mark");
  const blocks = (ctx.slack.messages("general").find((entry) => entry.ts === outcome.ts)?.blocks ??
    []) as Record<string, unknown>[];
  return { taskId, leadId, cardTs: outcome.ts, blocks };
}

async function votesOf(ctx: ScenarioContext, taskId: string) {
  const response = await ctx.api("GET", `/api/kv/_/${NAMESPACE}?prefix=${taskId}/`);
  expectStatus(response, [200], `list the votes of task ${taskId}`);
  const entries = asRecord(response.json).entries;
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const row = asRecord(entry);
    return { key: String(row.key), value: asRecord(row.value) };
  });
}

/** Clicks 👍 or 👎 as `user` and waits until the vote is stored. */
async function vote(
  ctx: ScenarioContext,
  card: { taskId: string; cardTs: string },
  choice: "up" | "down",
  user: string,
) {
  // The mock clicks plain buttons; the handler reads only the value, as with Slack's feedback element.
  const ack = await ctx.slack.clickButton({
    channel: "general",
    ts: card.cardTs,
    action_id: "task_feedback",
    value: `${choice}:${card.taskId}`,
    user,
  });
  expect(ack.attempts === 1, `The ${choice} click needed ${ack.attempts} delivery attempts`);
  const stored = await pollUntil(
    async () => (await votesOf(ctx, card.taskId)).some((row) => row.value.vote === choice),
    15_000,
  );
  expect(stored, `The ${choice} vote on task ${card.taskId} was not stored`);
}

/**
 * `SLACK_FEEDBACK_BUTTONS=true` puts Slack's 👍/👎 under the final outcome card, carrying the
 * task id. A click stores one vote per person per task in the `slack-feedback` KV namespace
 * (the last click wins), and agents cannot write that namespace. With the flag off, the card has
 * no buttons.
 */
export const slackFeedbackButtons: Scenario = {
  name: "slack-feedback-buttons",
  order: 134.55,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await ctx.restartSut({ env: { SLACK_FEEDBACK_BUTTONS: "true", UI_SPEC_ENABLED: "true" } });
    try {
      const leadId = await registerLead(ctx, `e2e-lead-feedback-${ctx.nonce}`);
      const card = await answer(ctx, "feedback-on");
      const feedback = card.blocks.find((block) => block.type === "context_actions");
      const rendered = JSON.stringify(feedback ?? {});
      expect(
        card.blocks.at(-1) === feedback &&
          rendered.includes('"feedback_buttons"') &&
          rendered.includes(`"up:${card.taskId}"`) &&
          rendered.includes(`"down:${card.taskId}"`),
        `The outcome does not end with feedback buttons for its task: ${JSON.stringify(card.blocks)}`,
      );

      await vote(ctx, card, "up", "alice");
      const [first] = await votesOf(ctx, card.taskId);
      expect(
        first?.value.taskId === card.taskId &&
          first.value.agentId === card.leadId &&
          first.value.messageTs === card.cardTs &&
          typeof first.value.slackUserId === "string" &&
          first.key === `${card.taskId}/${first.value.slackUserId}`,
        `The vote row misses the task, agent or message: ${JSON.stringify(first)}`,
      );

      // The same person changes their mind: one row, now down. Another person adds a row.
      await vote(ctx, card, "down", "alice");
      const changed = await votesOf(ctx, card.taskId);
      expect(
        changed.length === 1 && changed[0]?.value.vote === "down",
        `A second click by the same person did not replace the vote: ${JSON.stringify(changed)}`,
      );
      await vote(ctx, card, "up", "bob");
      const both = await votesOf(ctx, card.taskId);
      expect(
        both.length === 2 && both.filter((row) => row.value.vote === "up").length === 1,
        `Two people should hold one vote each: ${JSON.stringify(both)}`,
      );

      // A value that names no task of this channel stores nothing.
      await ctx.slack.clickButton({
        channel: "general",
        ts: card.cardTs,
        action_id: "task_feedback",
        value: "up:00000000-0000-4000-8000-000000000000",
        user: "alice",
      });
      const stray = await votesOf(ctx, "00000000-0000-4000-8000-000000000000");
      expect(
        stray.length === 0,
        `A click for an unknown task stored a vote: ${JSON.stringify(stray)}`,
      );

      // Only a Slack click writes votes: an agent's KV write is refused.
      const forged = await ctx.api("PUT", `/api/kv/_/${NAMESPACE}/forged-${card.taskId}`, {
        body: { value: { vote: "up" } },
        headers: { "X-Agent-ID": leadId },
      });
      expectStatus(forged, [403], "an agent write to the slack-feedback namespace");

      // Slack refuses the blocks once: the buttons go first, so the task's card and footer stay.
      ctx.slack.injectFault({ method: "chat.stopStream", error: "invalid_blocks" });
      const rejected = await answer(ctx, "feedback-rejected", {
        spec: {
          root: "card",
          elements: {
            card: { type: "Card", props: { title: "Preserve this card" }, children: ["text"] },
            text: { type: "Text", props: { content: "Valuable structured answer" }, children: [] },
          },
        },
      });
      const kept = JSON.stringify(rejected.blocks);
      expect(
        !kept.includes("feedback_buttons") &&
          kept.includes("Preserve this card") &&
          kept.includes("Valuable structured answer") &&
          kept.includes(rejected.taskId.slice(0, 8)),
        `The card after a block rejection should keep its uiSpec card and footer and drop the buttons: ${kept}`,
      );
    } finally {
      await ctx.restartSut();
    }

    // The default setting: the same card, with no buttons. The pair is the visual proof.
    const off = await answer(ctx, "feedback-off");
    expect(
      !JSON.stringify(off.blocks).includes("feedback_buttons"),
      `The outcome has feedback buttons with the setting off: ${JSON.stringify(off.blocks)}`,
    );
  },
};
