import { asRecord, expect, expectStatus, pollUntil } from "../http";
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
  waitForEyes,
  waitForOutcome,
} from "./slack-helpers";

// Run before delegation is enabled (order 140). With delegation off, the
// ask finalizes while its worker is still running, reproducing the late
// Lead-review answer that must have its own direct delivery path.
export const slackReviewAnswer: Scenario = {
  name: "slack-review-answer",
  order: 136,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, "e2e-lead-review-answer");
    const workerId = await registerWorker(ctx, "e2e-worker-review-answer");
    const message = await ask(ctx, "review the specialist's findings and answer here");
    ctx.markThread("review-answer", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);
    const askTask = await findSlackTask(ctx, message.ts);
    const askId = String(askTask.id);
    const leadId = String(askTask.agentId);
    await claim(ctx, leadId, askId);
    const childId = await createChildTask(ctx, askId, workerId, `investigate ${ctx.nonce}`);
    await claim(ctx, workerId, childId);
    const askOutput = `Specialist review requested ${ctx.nonce}`;
    await finish(ctx, leadId, askId, { status: "completed", output: askOutput });
    const conclusion = await waitForOutcome(ctx, message.ts, askOutput);
    const finalized = await pollUntil(
      () =>
        !!ctx.db.get<{ finalized_at: string | null }>(
          "SELECT finalized_at FROM slack_messages WHERE task_id = ? AND kind = 'outcome'",
          [askId],
        )?.finalized_at,
      30_000,
    );
    expect(finalized, "Ask conclusion must finalize before creating the Lead review");
    const conclusionSnapshot = JSON.stringify(conclusion);

    // Both reviews are produced by real worker completions, never seeded
    // with tags. A blank answer must fail closed even with slack-answer.
    const answer = `Reviewed findings: ship the targeted fix ${ctx.nonce}`;
    // The runner finish endpoint replaces an empty string with fallback text;
    // whitespace preserves a genuinely blank persisted output.
    for (const output of ["   ", answer]) {
      const hasAnswer = output.trim().length > 0;
      const taskId = hasAnswer
        ? await createChildTask(ctx, askId, workerId, `confirm findings ${ctx.nonce}`)
        : childId;
      if (hasAnswer) await claim(ctx, workerId, taskId);
      await finish(ctx, workerId, taskId, { status: "completed", output: "Findings ready." });
      let review: Record<string, unknown> | undefined;
      const found = await pollUntil(async () => {
        const response = await ctx.api("GET", `/api/tasks?agentId=${leadId}&fields=full&limit=50`);
        expectStatus(response, [200], "find generated Lead review");
        const tasks = asRecord(response.json).tasks;
        expect(Array.isArray(tasks), "Lead task list has no tasks array");
        review = tasks.map(asRecord).find((task) => task.parentTaskId === taskId);
        return review !== undefined;
      }, 15_000);
      expect(found && review, "Worker completion did not create a Lead review");
      const reviewTask = asRecord(review);
      expect(reviewTask.source === "system", "Review must be engine-created");
      expect(reviewTask.taskType === "follow-up", "Review must be a follow-up");
      expect(
        Array.isArray(reviewTask.tags) && reviewTask.tags.includes("slack-answer"),
        "Review must carry slack-answer at creation",
      );
      expect(reviewTask.slackThreadTs === message.ts, "Review lost the human ask's thread");
      const reviewId = String(reviewTask.id);
      await claim(ctx, leadId, reviewId);
      await finish(ctx, leadId, reviewId, { status: "completed", output });

      if (!hasAnswer) {
        // Observe the full delivery timeout used by the positive control.
        // The ledger catches even an empty/generic card with no output text.
        const delivered = await pollUntil(
          () =>
            !!ctx.db.get("SELECT id FROM slack_messages WHERE task_id = ? AND kind = 'outcome'", [
              reviewId,
            ]),
          30_000,
        );
        expect(!delivered, "Blank Lead review must not reserve or send an outcome card");
      } else {
        const card = await waitForOutcome(ctx, message.ts, answer);
        expect(card.ts !== conclusion.ts, "Lead answer must get its own card");
        const delivered = await pollUntil(
          () =>
            !!ctx.db.get(
              "SELECT id FROM slack_messages WHERE task_id = ? AND kind = 'outcome' AND ts = ? AND finalized_at IS NOT NULL",
              [reviewId, card.ts],
            ),
          30_000,
        );
        expect(delivered, "Lead answer card must finalize under the review's own task ID");
      }
    }
    const unchanged = ctx.slack.messages("general").find((item) => item.ts === conclusion.ts);
    expect(JSON.stringify(unchanged) === conclusionSnapshot, "Finalized conclusion was mutated");
  },
};
