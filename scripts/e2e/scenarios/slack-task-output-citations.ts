import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  registerLead,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

export const slackTaskOutputCitations: Scenario = {
  name: "slack-task-output-citations",
  // V2-only: after legacy coverage, before delegation is enabled globally.
  order: 136,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, "e2e-lead-citations");
    const ref = "https://example.com/citation-evidence";
    const citation = { index: 1, kind: "url", ref, label: "Release evidence" };
    const cases = [
      { name: "valid", citations: [citation], count: 1 },
      { name: "invalid", citations: [{ ...citation, index: 0 }], count: 0 },
      {
        name: "oversized",
        citations: Array.from({ length: 51 }, (_, index) => ({ ...citation, index: index + 1 })),
        count: 0,
      },
    ];

    for (const testCase of cases) {
      const message = await ask(ctx, `summarize the release with ${testCase.name} citations`);
      ctx.markThread(testCase.name, "C0GENERAL0", message.ts);
      await waitForEyes(ctx, message.ts);
      const task = await findSlackTask(ctx, message.ts);
      const taskId = String(task.id);
      const leadId = String(task.agentId);
      await claim(ctx, leadId, taskId);
      const summary = `Release checked (${testCase.name}).`;
      const output = `${summary} [citation:1]`;
      const mcp = await ctx.connectMcp(leadId);
      try {
        const result = await mcp.callTool("store-progress", {
          taskId,
          status: "completed",
          output,
          citations: testCase.citations,
        });
        expect(!result.isError, `store-progress ${testCase.name}: ${JSON.stringify(result)}`);
      } finally {
        await mcp.close();
      }

      const response = await ctx.api("GET", `/api/tasks/${taskId}`);
      expectStatus(response, [200], `read ${testCase.name} citation task`);
      expect(
        asRecord(response.json).status === "completed",
        `${testCase.name} task did not complete`,
      );
      const stored = ctx.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM task_citations WHERE task_id = ?",
        [taskId],
      );
      expect(
        stored?.count === testCase.count,
        `${testCase.name} batch persisted unexpected citations`,
      );

      const outcome = await waitForOutcome(ctx, message.ts, summary);
      expect(outcome.bot_id === ctx.slack.bot.botId, "Citation outcome must come from the bot");
      const stopped = await ctx.slack.waitForApiCall("chat.stopStream", {
        timeoutMs: 30_000,
        where: (call) => call.args.ts === outcome.ts && call.args.channel === "C0GENERAL0",
      });
      expect(stopped.ok === true, `${testCase.name} outcome did not finish streaming`);
      const rendered = JSON.stringify(
        ctx.slack.messages("general").find((entry) => entry.ts === outcome.ts),
      );
      expect(!rendered.includes("[citation:1]"), "Outcome leaked a raw citation marker");
      if (testCase.count > 0) {
        expect(rendered.includes(`<${ref}|[1]>`), "Outcome omitted the linked citation marker");
        expect(
          rendered.includes(`Sources: <${ref}|[1]> Release evidence`),
          "Outcome omitted the labeled source list",
        );
      } else {
        expect(rendered.includes("[1]"), "Ignored citation must leave a plain numeric marker");
        expect(!rendered.includes("Sources:"), "Ignored batch rendered a source list");
        expect(!rendered.includes(ref), "Ignored batch rendered a citation URL");
      }
      await waitForReaction(ctx, message.ts, "white_check_mark");
    }
  },
};
