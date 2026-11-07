import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  registerLead,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

const leaf = (type: string, props: Record<string, unknown>) => ({ type, props, children: [] });

/** The weekly deploys card: a Card with fields, a table and a link button. */
function deploysSpec(url: string) {
  return {
    spec: {
      root: "c",
      elements: {
        c: { type: "Card", props: { title: "Weekly deploys" }, children: ["f", "t", "a"] },
        f: { type: "Fields", props: {}, children: ["k"] },
        k: leaf("Field", { label: "Deploys", value: "1,284" }),
        t: leaf("Table", {
          headers: ["Service", "Deploys"],
          rows: [
            ["api", 812],
            ["ui", 472],
          ],
        }),
        a: { type: "Actions", props: {}, children: ["l"] },
        l: leaf("LinkButton", { label: "Open dashboard", url }),
      },
    },
  };
}

type Block = Record<string, unknown>;

async function waitForUiSpecFlag(ctx: ScenarioContext, present: boolean): Promise<void> {
  const live = await pollUntil(async () => {
    const response = await ctx.api("GET", "/api/config/env-presence?keys=UI_SPEC_ENABLED");
    expectStatus(response, [200], "check UI_SPEC_ENABLED presence");
    const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
    return presence?.UI_SPEC_ENABLED === present;
  }, 10_000);
  expect(live, `UI_SPEC_ENABLED presence never became ${present} within 10 seconds`);
}

/** Posts a Slack ask and returns the thread ts, the task id and the lead that owns it. */
async function askAndClaim(ctx: ScenarioContext, label: string, text: string) {
  // Bob, not Alice: Alice's 10-per-minute allowance is shared with the other visuals scenarios.
  const message = await ctx.slack.postMessage({
    channel: "general",
    user: "bob",
    text: `<@${ctx.slack.bot.userId}> ${text}`,
  });
  ctx.markThread(label, "C0GENERAL0", message.ts);
  await waitForEyes(ctx, message.ts);
  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claim(ctx, leadId, taskId);
  return { ts: message.ts, taskId, leadId };
}

/**
 * A lead completes a Slack task with a `uiSpec`: the outcome message carries the card as
 * native Block Kit between the answer and the footer. A spec with a `javascript:` URL
 * refuses the first completion. Button clicks stay in unit tests: the Slack mock has no
 * inbound `block_actions`.
 */
export const slackTaskOutputUiSpec: Scenario = {
  name: "slack-task-output-ui-spec",
  // V2-only, like slack-task-output-citations: the outcome card needs the v2 tree.
  order: 133,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    const upsert = await ctx.api("PUT", "/api/config", {
      body: {
        scope: "global",
        scopeId: null,
        key: "UI_SPEC_ENABLED",
        value: "true",
        isSecret: false,
      },
    });
    expectStatus(upsert, [200], "enable UI_SPEC_ENABLED");
    const configId = String(asRecord(upsert.json).id);

    try {
      await waitForUiSpecFlag(ctx, true);
      await registerLead(ctx, `e2e-lead-ui-spec-${ctx.nonce}`);

      // A valid spec: the outcome message carries the card blocks.
      const valid = await askAndClaim(ctx, "ui-spec", "send me the weekly deploys as a card");
      const summary = "Weekly deploys are ready.";
      const mcp = await ctx.connectMcp(valid.leadId);
      try {
        const result = await mcp.callTool("store-progress", {
          taskId: valid.taskId,
          status: "completed",
          output: summary,
          uiSpec: deploysSpec("https://example.com/deploys"),
        });
        expect(!result.isError, `store-progress with a uiSpec: ${JSON.stringify(result)}`);
      } finally {
        await mcp.close();
      }

      const outcome = await waitForOutcome(ctx, valid.ts, summary);
      expect(outcome.bot_id === ctx.slack.bot.botId, "The card outcome must come from the bot");
      const stopped = await ctx.slack.waitForApiCall("chat.stopStream", {
        timeoutMs: 30_000,
        where: (call) => call.args.ts === outcome.ts && call.args.channel === "C0GENERAL0",
      });
      expect(stopped.ok === true, "The card outcome did not finish streaming");
      const posted = ctx.slack.messages("general").find((entry) => entry.ts === outcome.ts);
      expect(posted, `The outcome ${outcome.ts} is not in the thread`);
      const blocks = (posted.blocks ?? []) as Block[];
      const types = blocks.map((block) => String(block.type));
      const footer = JSON.stringify(blocks.at(-1));
      expect(
        types.at(-1) === "context" && footer.includes(valid.taskId.slice(0, 8)),
        `The provenance footer does not close the outcome: ${footer}`,
      );
      expect(
        types.slice(0, -1).some((type) => type !== "markdown" && type !== "context"),
        `The outcome has no card block before the footer: ${JSON.stringify(types)}`,
      );
      const rendered = JSON.stringify(blocks);
      expect(
        rendered.includes("Weekly deploys") && rendered.includes("https://example.com/deploys"),
        `The outcome blocks do not carry the card: ${rendered}`,
      );
      await waitForReaction(ctx, valid.ts, "white_check_mark");

      // A javascript: URL: the first completion is refused and the task stays in progress.
      const unsafe = await askAndClaim(ctx, "ui-spec-unsafe", "send me the deploys card again");
      const unsafeMcp = await ctx.connectMcp(unsafe.leadId);
      try {
        const completion = {
          taskId: unsafe.taskId,
          status: "completed",
          output: "Deploys card, second try.",
          uiSpec: deploysSpec("javascript:alert(1)"),
        };
        const refused = await unsafeMcp.callTool("store-progress", completion);
        const text = JSON.stringify(refused);
        expect(
          refused.isError === true &&
            text.includes("uiSpec is not valid") &&
            text.includes("l.url must be an https: URL."),
          `store-progress with a javascript: URL was not refused: ${text}`,
        );
        const pending = await ctx.api("GET", `/api/tasks/${unsafe.taskId}`);
        expect(
          asRecord(pending.json).status === "in_progress",
          "The task left in_progress after the uiSpec refusal",
        );
        // The check refuses once per task: the next completion lands without the spec.
        const accepted = await unsafeMcp.callTool("store-progress", completion);
        expect(!accepted.isError, `second store-progress: ${JSON.stringify(accepted)}`);
      } finally {
        await unsafeMcp.close();
      }
      const stored = ctx.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM task_ui_specs WHERE task_id = ?",
        [unsafe.taskId],
      );
      expect(stored?.count === 0, "The refused spec was stored");
      await waitForReaction(ctx, unsafe.ts, "white_check_mark");
    } finally {
      expectStatus(
        await ctx.api("DELETE", `/api/config/${configId}`),
        [200],
        "delete UI_SPEC_ENABLED",
      );
      await waitForUiSpecFlag(ctx, false);
    }
  },
};
