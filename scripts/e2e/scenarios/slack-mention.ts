import { expect } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForBotReply,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

export const slackMention: Scenario = {
  name: "slack-mention",
  async run(ctx) {
    expect(ctx.slack.apiCalls("auth.test").length > 0, "Bolt never called auth.test on the mock");
    expect(
      ctx.slack.apiCalls("apps.connections.open").length > 0,
      "Bolt never called apps.connections.open on the mock",
    );
    expect(
      ctx.slack.hub.connectionCount === 1,
      `Expected one socket mode connection, found ${ctx.slack.hub.connectionCount}`,
    );

    const leadId = await registerLead(ctx, "e2e-lead-mention");
    const message = await ask(ctx, "say hello from the E2E worker");
    ctx.markThread("mention", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);

    const reply = await waitForBotReply(ctx, message.ts);
    expect(
      reply.thread_ts === message.ts,
      `Bot replied in general on thread ${String(reply.thread_ts)}, expected ${message.ts}`,
    );

    const task = await findSlackTask(ctx, message.ts);
    const taskId = String(task.id);
    expect(
      task.status === "pending",
      `Slack task ${taskId} is ${String(task.status)}, not pending`,
    );

    const row = ctx.db.get<{ source: string }>("SELECT source FROM agent_tasks WHERE id = ?", [
      taskId,
    ]);
    expect(
      row?.source === "slack",
      `agent_tasks row for ${taskId} has source ${row?.source ?? "<missing row>"}`,
    );

    await claim(ctx, leadId, taskId);
    const output = "Hello from the E2E worker.";
    await finish(ctx, leadId, taskId, { status: "completed", output });

    const outcome = await waitForOutcome(ctx, message.ts, output);
    expect(
      outcome.bot_id === ctx.slack.bot.botId,
      `Outcome message came from ${String(outcome.bot_id)}, expected the bot`,
    );
    await waitForReaction(ctx, message.ts, "white_check_mark");
  },
};
