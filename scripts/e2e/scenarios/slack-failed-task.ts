import { expect } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

export const slackFailedTask: Scenario = {
  name: "slack-failed-task",
  async run(ctx) {
    const leadId = await registerLead(ctx, "e2e-lead-failed");
    const message = await ask(ctx, "deploy the hotfix to staging");
    ctx.markThread("failed", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);

    const task = await findSlackTask(ctx, message.ts);
    const taskId = String(task.id);
    expect(
      task.status === "pending",
      `Slack task ${taskId} in general thread ${message.ts} is ${String(task.status)}, not pending`,
    );
    await claim(ctx, leadId, taskId);
    await finish(ctx, leadId, taskId, {
      status: "failed",
      output: "Deploy aborted: the staging database migration 131 failed a checksum.",
      failureReason: "migration checksum mismatch",
    });

    const outcome = await waitForOutcome(ctx, message.ts, "checksum");
    expect(
      outcome.bot_id === ctx.slack.bot.botId,
      `Outcome in C0GENERAL0 thread ${message.ts} came from ${String(outcome.bot_id)}, expected the bot`,
    );
    await waitForReaction(ctx, message.ts, "x");
  },
};
