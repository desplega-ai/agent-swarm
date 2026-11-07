import { asString, expect } from "../http";
import type { Scenario } from "../run";
import { callTool, expectToolError, expectToolOk } from "./platformb-helpers";
import {
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForReaction,
} from "./slack-helpers";

const leaf = (type: string, props: Record<string, unknown>) => ({ type, props, children: [] });

/** Every catalog component, with one table and the two charts Slack allows. */
const CARD = {
  root: "card",
  elements: {
    card: {
      type: "Card",
      props: { title: "Weekly deploy report", subtitle: "Nov 2 to Nov 8" },
      children: ["summary", "fields", "divider", "jobs", "table", "charts", "actions"],
    },
    summary: leaf("Text", { content: "Deploys are **up 12%** week over week." }),
    fields: { type: "Fields", props: {}, children: ["deploys", "failures", "p95"] },
    deploys: leaf("Field", { label: "Deploys", value: 1284 }),
    failures: leaf("Field", { label: "Failed", value: "3" }),
    p95: leaf("Field", { label: "p95 duration", value: "4m 12s" }),
    divider: leaf("Divider", {}),
    jobs: leaf("Text", { content: "Failures by job", style: "bold" }),
    table: leaf("Table", {
      headers: ["Project", "Deploys", "Failed"],
      rows: [
        ["web", "412", "1"],
        ["api", "203", "2"],
        ["worker", "669", "0"],
      ],
      caption: "Deploys per project",
    }),
    charts: { type: "Section", props: {}, children: ["daily", "share"] },
    daily: leaf("Chart", {
      title: "Deploys per day",
      chart: {
        type: "bar",
        categories: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        series: [
          { name: "web", values: [80, 92, 85, 77, 78] },
          { name: "api", values: [40, 44, 39, 41, 39] },
        ],
      },
    }),
    share: leaf("Chart", {
      title: "Deploys by project",
      chart: {
        type: "pie",
        segments: [
          { label: "web", value: 412 },
          { label: "api", value: 203 },
          { label: "worker", value: 669 },
        ],
      },
    }),
    actions: { type: "Actions", props: {}, children: ["dashboard"] },
    dashboard: leaf("LinkButton", { label: "Open dashboard", url: "https://example.com/deploys" }),
  },
};

type Block = Record<string, unknown>;

/**
 * A lead answers a Slack task with `slack-reply` and a json-render card: the mock receives
 * native Block Kit (header, fields, data_table, two data_visualization charts, a link button)
 * with the card's fallback text, and the provenance footer still closes the message. A card
 * using the callback Button comes back as a tool error and posts nothing.
 */
export const slackReplyCard: Scenario = {
  name: "slack-reply-card",
  // V2-only, like slack-task-output-citations: the provenance footer needs the v2 tree.
  order: 134,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, `e2e-lead-card-${ctx.nonce}`);
    // Bob, not Alice: Alice's 10-per-minute allowance is shared with the other visuals scenarios.
    const ask = await ctx.slack.postMessage({
      channel: "general",
      user: "bob",
      text: `<@${ctx.slack.bot.userId}> send me the weekly deploy report as a card`,
    });
    ctx.markThread("card", "C0GENERAL0", ask.ts);
    await waitForEyes(ctx, ask.ts);
    const task = await findSlackTask(ctx, ask.ts);
    const taskId = String(task.id);
    const leadId = String(task.agentId);
    await claim(ctx, leadId, taskId);
    const threadMessages = () =>
      ctx.slack.messages("general").filter((message) => message.thread_ts === ask.ts);

    const mcp = await ctx.connectMcp(leadId);
    try {
      const before = threadMessages().length;
      expectToolError(
        await callTool(mcp, "slack-reply", {
          taskId,
          card: {
            root: "card",
            elements: {
              card: { type: "Card", props: {}, children: ["actions"] },
              actions: { type: "Actions", props: {}, children: ["approve"] },
              approve: leaf("Button", { id: "approve", label: "Approve" }),
            },
          },
        }),
        'approve: unknown component "Button"',
        "slack-reply with a callback Button",
      );
      expect(threadMessages().length === before, "An invalid card still posted a message");

      const outcome = expectToolOk(
        await callTool(mcp, "slack-reply", {
          taskId,
          message: "Here is this week's report.",
          card: CARD,
        }),
        "slack-reply with a card",
      );
      const ts = asString(outcome.data.messageTs, "card reply ts");
      const posted = threadMessages().find((message) => message.ts === ts);
      expect(posted, `The card reply ${ts} is not in the thread`);
      const blocks = (posted.blocks ?? []) as Block[];
      const types = blocks.map((block) => block.type);
      expect(
        JSON.stringify(types) ===
          JSON.stringify([
            "section",
            "header",
            "context",
            "section",
            "section",
            "divider",
            "section",
            "data_table",
            "data_visualization",
            "data_visualization",
            "actions",
            "context",
          ]),
        `Card reply blocks are ${JSON.stringify(types)}`,
      );
      const footer = JSON.stringify(blocks.at(-1));
      expect(footer.includes(taskId.slice(0, 8)), `The provenance footer is missing: ${footer}`);
      const button = JSON.stringify(blocks.at(-2));
      expect(
        button.includes('"url":"https://example.com/deploys"'),
        `The link button lost its url: ${button}`,
      );
      expect(
        posted.text?.includes("Weekly deploy report") && posted.text.includes("Deploys: 1284"),
        `The fallback text does not carry the card: ${posted.text}`,
      );
      expect(
        posted.text?.startsWith("Here is this week's report."),
        `The fallback text does not lead with the message: ${posted.text}`,
      );
    } finally {
      await mcp.close();
    }

    await finish(ctx, leadId, taskId, { status: "completed", output: "Card report sent." });
    // The agent already replied (slackReplySent), so the engine posts no outcome message.
    await waitForReaction(ctx, ask.ts, "white_check_mark");
  },
};
