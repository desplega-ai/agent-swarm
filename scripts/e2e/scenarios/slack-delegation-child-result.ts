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

// The base case for PR #1272's delegated-delivery story (plan section 3.4):
// an ask delegates to one child, the child gets its own result card in the
// originating thread, and the ask's own conclusion card is deferred until
// the child settles too — then its "Results" section names the specialist.
export const slackDelegationChildResult: Scenario = {
  name: "slack-delegation-child-result",
  async run(ctx) {
    await enableSlackDelegation(ctx);

    // Guarantees at least one lead exists so the ask lands directly assigned
    // (`pending`) instead of pooled. `getLeadAgent()` picks whichever
    // non-offline lead sorts first by name, which may not be this one when
    // other scenarios already registered a lead — read the real assignee
    // back off the ask task rather than assuming it's this agent.
    await registerLead(ctx, "e2e-lead-delegation");
    const workerId = await registerWorker(ctx, "e2e-specialist-delegation");

    const message = await ask(ctx, "draft the release notes and post them here");
    ctx.markThread("delegation-child-result", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);

    const askTask = await findSlackTask(ctx, message.ts);
    const askTaskId = String(askTask.id);
    const leadId = String(askTask.agentId);
    await claim(ctx, leadId, askTaskId);

    const childId = await createChildTask(
      ctx,
      askTaskId,
      workerId,
      `write the release-note bullets ${ctx.nonce}`,
    );
    await claim(ctx, workerId, childId);

    // The ask finishes first with a short delegation summary; its own
    // conclusion card must not post yet — the child is still running.
    await finish(ctx, leadId, askTaskId, {
      status: "completed",
      output: "Delegating the release-note draft to a specialist.",
    });

    const childOutput = `Drafted three bullet points for the ${ctx.nonce} release.`;
    await finish(ctx, workerId, childId, { status: "completed", output: childOutput });
    await settleWorkerFollowUp(ctx, leadId, childId);

    const childCard = await waitForOutcome(ctx, message.ts, childOutput);
    expect(
      childCard.bot_id === ctx.slack.bot.botId,
      `Child result card in C0GENERAL0 thread ${message.ts} came from ${String(childCard.bot_id)}, expected the bot`,
    );

    const conclusion = await waitForOutcome(ctx, message.ts, "Results");
    expect(
      JSON.stringify(conclusion).includes("e2e-specialist-delegation"),
      `Ask conclusion in C0GENERAL0 thread ${message.ts} did not reference the delegated specialist`,
    );
    await waitForReaction(ctx, message.ts, "white_check_mark");
  },
};
