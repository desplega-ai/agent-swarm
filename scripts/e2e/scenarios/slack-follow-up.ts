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

export const slackFollowUp: Scenario = {
  name: "slack-follow-up",
  async run(ctx) {
    const leadId = await registerLead(ctx, "e2e-lead-follow-up");
    const firstAsk = await ask(ctx, "summarize the release notes");
    ctx.markThread("follow-up", "C0GENERAL0", firstAsk.ts);
    await waitForEyes(ctx, firstAsk.ts);

    const reply = await waitForBotReply(ctx, firstAsk.ts);
    expect(
      reply.thread_ts === firstAsk.ts,
      `Bot replied in general on thread ${String(reply.thread_ts)}, expected ${firstAsk.ts}`,
    );

    const firstTask = await findSlackTask(ctx, firstAsk.ts);
    const firstTaskId = String(firstTask.id);
    expect(
      firstTask.status === "pending",
      `Slack task ${firstTaskId} in general thread ${firstAsk.ts} is ${String(firstTask.status)}, not pending`,
    );
    await claim(ctx, leadId, firstTaskId);
    const firstOutput = "Three changes shipped: faster polling, a new Slack tree, and cost badges.";
    await finish(ctx, leadId, firstTaskId, { status: "completed", output: firstOutput });
    await waitForOutcome(ctx, firstAsk.ts, firstOutput);
    await waitForReaction(ctx, firstAsk.ts, "white_check_mark");

    const followUp = await ask(ctx, "and now list the open follow-ups", firstAsk.ts);
    await waitForEyes(ctx, followUp.ts);
    const followUpTask = await findSlackTask(ctx, followUp.ts);
    const followUpTaskId = String(followUpTask.id);
    expect(
      followUpTaskId !== firstTaskId,
      `Follow-up in general at ts ${followUp.ts} reused Slack task ${firstTaskId}`,
    );
    expect(
      followUpTask.slackTriggerMessageTs === followUp.ts,
      `Follow-up task ${followUpTaskId} in general has trigger ts ${String(followUpTask.slackTriggerMessageTs)}, expected ${followUp.ts}`,
    );
    expect(
      followUpTask.slackThreadTs === firstAsk.ts,
      `Follow-up task ${followUpTaskId} in general has thread ts ${String(followUpTask.slackThreadTs)}, expected ${firstAsk.ts}`,
    );
    expect(
      followUpTask.status === "pending",
      `Follow-up task ${followUpTaskId} in general thread ${firstAsk.ts} is ${String(followUpTask.status)}, not pending`,
    );
    await claim(ctx, leadId, followUpTaskId);
    const followUpOutput = "Two follow-ups are open: docs refresh and the retention PR.";
    await finish(ctx, leadId, followUpTaskId, {
      status: "completed",
      output: followUpOutput,
    });
    await waitForOutcome(ctx, firstAsk.ts, followUpOutput);
    await waitForReaction(ctx, followUp.ts, "white_check_mark");
  },
};
