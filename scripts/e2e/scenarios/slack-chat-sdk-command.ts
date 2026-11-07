import { expect } from "../http";
import type { Scenario } from "../run";
import {
  CHAT_SDK_SLACK_WEBHOOK,
  enableChatSdkSlack,
  expectHttpTransport,
} from "./slack-http-helpers";

export const slackChatSdkCommand: Scenario = {
  name: "slack-chat-sdk-command",
  order: 687,
  async run(ctx) {
    const flip = await enableChatSdkSlack(ctx);
    try {
      const slack = flip.mock;
      const chatTasksBefore = ctx.db.query<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE source = 'chat'",
      ).length;
      for (const [command, needle] of [
        ["/agent-swarm-help", "/status: Show the latest task of this chat"],
        ["/agent-swarm-status", "No task yet for this chat"],
      ] as const) {
        const { ack } = await slack.slashCommand({ command, user: "alice", channel: "general" });
        expect(ack.attempts === 1, `${command} needed ${ack.attempts} attempts`);
        // The adapter answers with a channel post, not the command's response_url.
        const posted = await slack
          .waitForMessage(
            (message) =>
              message.channel === "C0GENERAL0" &&
              message.bot_id === slack.bot.botId &&
              message.text.includes(needle),
            { timeoutMs: 30_000 },
          )
          .catch((error) => {
            throw new Error(
              `${command} reply "${needle}": ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        expect(
          !posted.thread_ts,
          `${command} answered in thread ${String(posted.thread_ts)}, not in the channel`,
        );
      }
      expect(
        slack.ephemeralMessages().length === 0,
        "A Chat SDK command answered ephemerally; it posts to the channel",
      );
      const chatTasksAfter = ctx.db.query<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE source = 'chat'",
      ).length;
      expect(
        chatTasksAfter === chatTasksBefore,
        `Slash commands created ${chatTasksAfter - chatTasksBefore} Chat SDK task(s)`,
      );
      await expectHttpTransport(ctx, flip, CHAT_SDK_SLACK_WEBHOOK);
    } finally {
      await flip.undo();
    }
  },
};
