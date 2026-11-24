import { expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
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
} from "./slack-helpers";

async function cancel(ctx: ScenarioContext, taskId: string): Promise<void> {
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: { reason: "Not needed" } }),
    [200],
    `cancel ${taskId}`,
  );
}

/** The v2 thread-tree status message: the bot reply whose text opens with 🧵. */
async function waitForTreeHeader(
  ctx: ScenarioContext,
  threadTs: string,
  header: string,
): Promise<void> {
  let text = "";
  const found = await pollUntil(() => {
    const tree = ctx.slack
      .messages("general")
      .find((entry) => entry.thread_ts === threadTs && String(entry.text ?? "").startsWith("🧵"));
    text = String(tree?.text ?? "");
    return text.startsWith(header);
  }, 15_000);
  expect(found, `Thread tree in ${threadTs} never read "${header}" within 15 seconds; last: ${text}`);
}

export const slackCancelledTask: Scenario = {
  name: "slack-cancelled-task",
  order: 139.6,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    const leadId = await registerLead(ctx, "e2e-lead-cancelled");
    const workerId = await registerWorker(ctx, "e2e-worker-cancelled");

    // The ask itself is cancelled.
    const direct = await ask(ctx, "rebuild the search index");
    ctx.markThread("cancelled-ask", "C0GENERAL0", direct.ts);
    await waitForEyes(ctx, direct.ts);
    const directTask = String((await findSlackTask(ctx, direct.ts)).id);
    await claim(ctx, leadId, directTask);
    await cancel(ctx, directTask);
    await waitForTreeHeader(ctx, direct.ts, "🧵 🚫 stopped");

    // The ask finished after delegating; only the delegated work is cancelled.
    const delegated = await ask(ctx, "collect last week's numbers");
    ctx.markThread("cancelled-delegated", "C0GENERAL0", delegated.ts);
    await waitForEyes(ctx, delegated.ts);
    const askId = String((await findSlackTask(ctx, delegated.ts)).id);
    await claim(ctx, leadId, askId);
    const childId = await createChildTask(ctx, askId, workerId, "collect last week's numbers");
    await finish(ctx, leadId, askId, { status: "completed", output: "Asked a worker." });
    await waitForTreeHeader(ctx, delegated.ts, "🧵 🔄 working");
    await cancel(ctx, childId);
    await waitForTreeHeader(ctx, delegated.ts, "🧵 🚫 stopped");

    // The lead cancels leftover delegated work, then finishes its answer: still done.
    const trimmed = await ask(ctx, "review the draft once");
    ctx.markThread("cancelled-then-done", "C0GENERAL0", trimmed.ts);
    await waitForEyes(ctx, trimmed.ts);
    const trimmedAsk = String((await findSlackTask(ctx, trimmed.ts)).id);
    await claim(ctx, leadId, trimmedAsk);
    const leftover = await createChildTask(ctx, trimmedAsk, workerId, "second review round");
    await cancel(ctx, leftover);
    await finish(ctx, leadId, trimmedAsk, { status: "completed", output: "The draft is ready." });
    await waitForTreeHeader(ctx, trimmed.ts, "🧵 ✅ done");
  },
};
