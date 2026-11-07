import { asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  CHAT_SDK_SLACK_WEBHOOK,
  enableChatSdkSlack,
  expectHttpTransport,
} from "./slack-http-helpers";

/**
 * Delivery only (Decision 1): the Chat SDK Slack stack registers no `onAction` handler and
 * posts no buttons, so a signed `block_actions` request can only be accepted and dropped.
 * The click targets a bot message with a button another app would have rendered.
 */
export const slackChatSdkInteractivity: Scenario = {
  name: "slack-chat-sdk-interactivity",
  order: 688,
  async run(ctx) {
    const flip = await enableChatSdkSlack(ctx);
    try {
      const slack = flip.mock;
      const card = await slack.postMessage({
        channel: "general",
        user: slack.bot.userId,
        text: "A card with a button",
        blocks: [
          {
            type: "actions",
            block_id: "e2e_actions",
            elements: [
              {
                type: "button",
                action_id: "cancel_task",
                text: { type: "plain_text", text: "Cancel" },
                value: "e2e-task",
              },
            ],
          },
        ],
      });
      await slack.flush();
      const logBefore = (await ctx.sutLog()).length;
      const tasksBefore = ctx.db.query<{ id: string }>("SELECT id FROM agent_tasks").length;

      const ack = await slack.clickButton({
        channel: "general",
        ts: card.ts,
        action_id: "cancel_task",
        user: "alice",
      });
      expect(ack.attempts === 1, `block_actions needed ${ack.attempts} delivery attempts`);

      const delivery = slack.deliveries("block_actions").at(-1);
      expect(
        delivery?.acked === true,
        "The signed block_actions delivery was not acked with a 2xx",
      );
      // Give a (wrong) async handler time to create a task or fail before asserting absence.
      await Bun.sleep(1_000);
      expect(
        ctx.db.query<{ id: string }>("SELECT id FROM agent_tasks").length === tasksBefore,
        "A Chat SDK block_actions delivery created or cancelled a task",
      );
      const added = (await ctx.sutLog()).slice(logBefore);
      expect(
        added.includes(`POST ${CHAT_SDK_SLACK_WEBHOOK} → 200`),
        "The SUT log has no 200 for the block_actions delivery",
      );
      const problems = added
        .split("\n")
        .filter((line) =>
          /✗|\b(error|warn(ing)?)\b|^\[chat-sdk[^\]]*\].*\b(fail|could not)/i.test(line),
        );
      expect(
        problems.length === 0,
        `The SUT logged a problem for a block_actions delivery:\n${problems.join("\n")}`,
      );
      const status = await ctx.api("GET", "/api/integrations/chat/status");
      expectStatus(status, [200], "Chat SDK status after block_actions");
      expect(
        asRecords(status.json, "adapters").find((adapter) => adapter.name === "slack")?.health ===
          "ok",
        "The Chat SDK Slack adapter is no longer healthy after block_actions",
      );
      expect(
        slack.messages("general").at(-1)?.ts === card.ts,
        "The bot answered a block_actions delivery",
      );
      await expectHttpTransport(ctx, flip, CHAT_SDK_SLACK_WEBHOOK);
    } finally {
      await flip.undo();
    }
  },
};
