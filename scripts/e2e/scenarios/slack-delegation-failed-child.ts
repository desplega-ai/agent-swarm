import { expect } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  createChildTask,
  enableSlackDelegation,
  findSlackTask,
  finish,
  registerLead,
  registerWorker,
  settleWorkerFollowUp,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

// Negative case: a delegated child fails while the ask itself already
// completed. The child gets its own ❌ card, and the deferred conclusion's
// reaction flips to a cross even though the ask task never failed on its own
// — distinct from slack-failed-task, where the ask itself is the failure.
export const slackDelegationFailedChild: Scenario = {
  name: "slack-delegation-failed-child",
  async run(ctx) {
    await enableSlackDelegation(ctx);

    // See slack-delegation-child-result.ts: don't assume this freshly
    // registered lead is the one the ask lands on — read it back instead.
    await registerLead(ctx, "e2e-lead-delegation-failed");
    const workerId = await registerWorker(ctx, "e2e-specialist-delegation-failed");

    const message = await ask(ctx, "run the staging smoke suite and report back");
    ctx.markThread("delegation-failed-child", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);

    const askTask = await findSlackTask(ctx, message.ts);
    const askTaskId = String(askTask.id);
    const leadId = String(askTask.agentId);
    await claim(ctx, leadId, askTaskId);

    const childId = await createChildTask(
      ctx,
      askTaskId,
      workerId,
      `run the smoke suite ${ctx.nonce}`,
    );
    await claim(ctx, workerId, childId);

    await finish(ctx, leadId, askTaskId, {
      status: "completed",
      output: "Delegating the smoke suite run to a specialist.",
    });

    const failureReason = `smoke suite flaked on auth ${ctx.nonce}`;
    await finish(ctx, workerId, childId, { status: "failed", failureReason });
    await settleWorkerFollowUp(ctx, leadId, childId);

    const childCard = await waitForOutcome(ctx, message.ts, failureReason);
    expect(
      childCard.bot_id === ctx.slack.bot.botId,
      `Failed child card in C0GENERAL0 thread ${message.ts} came from ${String(childCard.bot_id)}, expected the bot`,
    );

    const conclusion = await waitForOutcome(ctx, message.ts, "Results");
    expect(
      JSON.stringify(conclusion).includes("e2e-specialist-delegation-failed"),
      `Ask conclusion in C0GENERAL0 thread ${message.ts} did not reference the failed specialist`,
    );
    await waitForReaction(ctx, message.ts, "x");
  },
};
