import { expect, pollUntil } from "../http";
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

// Edge case: the ask task itself reaches a terminal status well before its
// delegated child does. The conclusion card must stay deferred the whole
// time the child is still running — no early "Results" card, no early
// reaction — and only render once the child finishes too (plan section 3.1's
// closure state: "open" while any member is non-terminal, "settled" only
// once every member is).
export const slackDelegationLateChild: Scenario = {
  name: "slack-delegation-late-child",
  async run(ctx) {
    await enableSlackDelegation(ctx);

    // See slack-delegation-child-result.ts: don't assume this freshly
    // registered lead is the one the ask lands on — read it back instead.
    await registerLead(ctx, "e2e-lead-delegation-late");
    const workerId = await registerWorker(ctx, "e2e-specialist-delegation-late");

    const message = await ask(ctx, "kick off the docs regen and let me know when it lands");
    ctx.markThread("delegation-late-child", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);

    const askTask = await findSlackTask(ctx, message.ts);
    const askTaskId = String(askTask.id);
    const leadId = String(askTask.agentId);
    await claim(ctx, leadId, askTaskId);

    const childId = await createChildTask(
      ctx,
      askTaskId,
      workerId,
      `regenerate the docs site ${ctx.nonce}`,
    );
    await claim(ctx, workerId, childId);

    await finish(ctx, leadId, askTaskId, {
      status: "completed",
      output: "Delegating the docs regen; I'll report back once it lands.",
    });

    // Give the watcher several ticks to prove it does NOT conclude early
    // while the child is still running.
    const concludedEarly = await pollUntil(
      () =>
        ctx.slack
          .messages("general")
          .some(
            (candidate) =>
              candidate.thread_ts === message.ts && JSON.stringify(candidate).includes("Results"),
          ),
      8_000,
    );
    expect(
      !concludedEarly,
      `Ask conclusion in C0GENERAL0 thread ${message.ts} posted before the delegated child finished`,
    );

    const childOutput = `Docs regen finished for ${ctx.nonce}.`;
    await finish(ctx, workerId, childId, { status: "completed", output: childOutput });
    await settleWorkerFollowUp(ctx, leadId, childId);

    const childCard = await waitForOutcome(ctx, message.ts, childOutput);
    expect(
      childCard.bot_id === ctx.slack.bot.botId,
      `Late child result card in C0GENERAL0 thread ${message.ts} came from ${String(childCard.bot_id)}, expected the bot`,
    );

    await waitForOutcome(ctx, message.ts, "Results");
    await waitForReaction(ctx, message.ts, "white_check_mark");
  },
};
