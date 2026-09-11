import type { Scenario } from "../run";
import {
  ask,
  claim,
  createChildTask,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  registerWorker,
  settleWorkerFollowUp,
  waitForEyes,
  waitForOutcome,
  waitForOutcomeAbsence,
  waitForReaction,
} from "./slack-helpers";

// Reproduces the production incident (Daniel, 2026-09-09): a delegated
// child's finished answer never reached the originating Slack thread. The
// running config at the time — confirmed by Taras — was SLACK_RENDER_V2 on,
// SLACK_RENDER_V2_DELEGATION off. Every other slackDelegation* scenario below
// turns delegation ON before it asserts anything, so none of them exercise
// that state; this is the flag-off negative control.
//
// Mechanism (src/slack/render-v2.ts, processSlackRenderV2): the child-card
// loop bails unconditionally when delegation is off —
// `if (!delegationEnabled || delegationActivatedAt === null) continue;` — so
// a delegated child never gets a card, ever, regardless of how it finishes.
// The ask's own conclusion also never defers (`deferByClosure` requires
// `delegationEnabled`), so it streams the moment the ask itself goes
// terminal. The thread looks resolved — reaction and all — while the child's
// real answer sits in the DB with no delivery path.
//
// Ordering is load-bearing: enableSlackDelegation (called by every
// slackDelegation* scenario below) flips SLACK_RENDER_V2_DELEGATION on
// globally for the rest of the process (see enableSlackRenderV2Only's
// docstring). This scenario must run before all of them or its flag-off
// premise is unreachable — hence the low `order` below (130), well ahead of
// slack-delegation-child-result/failed-child/late-child (140/150/160), which
// enable delegation and leave it on for the rest of the run.
export const slackDelegationFlagOffRepro: Scenario = {
  name: "slack-delegation-flag-off-repro",
  order: 130,
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);

    // See slack-delegation-child-result.ts: don't assume this freshly
    // registered lead is the one the ask lands on — read it back instead.
    await registerLead(ctx, "e2e-lead-delegation-flagoff");
    const workerId = await registerWorker(ctx, "e2e-specialist-delegation-flagoff");

    const message = await ask(ctx, "kick off the changelog draft and report back here");
    ctx.markThread("delegation-flag-off-repro", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);

    const askTask = await findSlackTask(ctx, message.ts);
    const askTaskId = String(askTask.id);
    const leadId = String(askTask.agentId);
    await claim(ctx, leadId, askTaskId);

    const childId = await createChildTask(
      ctx,
      askTaskId,
      workerId,
      `draft the changelog ${ctx.nonce}`,
    );
    await claim(ctx, workerId, childId);

    const askOutput = "I'll get a specialist on the changelog draft and report back here.";
    await finish(ctx, leadId, askTaskId, { status: "completed", output: askOutput });

    // With delegation off, the ask's own conclusion is never deferred by a
    // closure — it streams and gets its reaction the moment the ask itself
    // goes terminal, well before the delegated child has finished. The
    // thread already looks closed out at this point.
    await waitForOutcome(ctx, message.ts, askOutput);
    await waitForReaction(ctx, message.ts, "white_check_mark");

    const childOutput = `Changelog draft ready for ${ctx.nonce}.`;
    await finish(ctx, workerId, childId, { status: "completed", output: childOutput });
    await settleWorkerFollowUp(ctx, leadId, childId);

    // The repro: the child's finished answer never posts anywhere in the
    // thread, no matter how long the watcher keeps ticking. Timeout matches
    // slack-delegation-child-result.ts's waitForOutcome default for the
    // equivalent flag-on child card, so this is a bounded assertion of
    // absence, not a race won by polling too briefly.
    await waitForOutcomeAbsence(ctx, message.ts, childOutput, 30_000);
  },
};
