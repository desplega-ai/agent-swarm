import { expect } from "../http";
import type { Scenario } from "../run";
import { callTool, expectToolOk } from "./platformb-helpers";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForReaction,
  waitForReactionAbsence,
} from "./slack-helpers";

const RETRY_AFTER_SEC = 20;

/**
 * Slack rate-limits a reaction removal while another ask is in flight. The
 * reply to that ask must not wait for the rate limit to clear, and the
 * limited removal still lands once it does.
 */
export const slackReactionRateLimit: Scenario = {
  name: "slack-reaction-rate-limit",
  order: 111,
  async run(ctx) {
    await registerLead(ctx, `e2e-lead-reaction-limit-${ctx.nonce}`);
    const first = await ask(ctx, "archive the old dashboards");
    await waitForEyes(ctx, first.ts);
    const firstTask = await findSlackTask(ctx, first.ts);
    const leadId = String(firstTask.agentId);
    await claim(ctx, leadId, String(firstTask.id));

    const second = await ctx.slack.postMessage({
      channel: "general",
      user: "bob",
      text: `<@${ctx.slack.bot.userId}> list the open incidents`,
    });
    await waitForEyes(ctx, second.ts);
    const secondId = String((await findSlackTask(ctx, second.ts)).id);

    ctx.slack.injectFault({
      method: "reactions.remove",
      error: "ratelimited",
      httpStatus: 429,
      retryAfterSec: RETRY_AFTER_SEC,
    });
    await finish(ctx, leadId, String(firstTask.id), {
      status: "completed",
      output: "Dashboards archived.",
    });
    await ctx.slack.waitForApiCall("reactions.remove", {
      timeoutMs: 30_000,
      where: (call) => call.args.timestamp === first.ts && call.error === "ratelimited",
    });

    await claim(ctx, leadId, secondId);
    const mcp = await ctx.connectMcp(leadId);
    try {
      const started = Date.now();
      expectToolOk(
        await callTool(mcp, "slack-reply", {
          taskId: secondId,
          message: `No open incidents ${ctx.nonce}`,
        }),
        "slack-reply while a reaction removal is rate-limited",
      );
      const elapsedMs = Date.now() - started;
      expect(
        elapsedMs < (RETRY_AFTER_SEC * 1000) / 2,
        `slack-reply took ${elapsedMs}ms behind a reaction rate limit of ${RETRY_AFTER_SEC}s`,
      );
    } finally {
      await mcp.close();
    }
    await finish(ctx, leadId, secondId, { status: "completed", output: "Replied in the thread." });

    await waitForReaction(ctx, first.ts, "white_check_mark", 60_000);
    await waitForReactionAbsence(ctx, first.ts, "eyes", 60_000);
  },
};
