import { expect } from "../http";
import type { Scenario } from "../run";
import { ask, claim, finish, registerLead, waitForOutcome } from "./slack-helpers";
import {
  CHAT_SDK_SLACK_WEBHOOK,
  enableChatSdkSlack,
  expectHttpTransport,
  waitForChatTask,
} from "./slack-http-helpers";

export const slackChatSdkMention: Scenario = {
  name: "slack-chat-sdk-mention",
  // Before platform-file-import (690), the suite's last restart: the boot sweep fails the
  // in_progress tasks earlier scenarios left 5s after a restart, and the strict gate needs
  // that status in the final database, so nothing may run for long after that restart.
  order: 686,
  async run(ctx) {
    const flip = await enableChatSdkSlack(ctx);
    try {
      const leadId = await registerLead(ctx, "e2e-lead-chat-sdk-mention");
      const message = await ask(flip.ctx, `swarm#${leadId} say hello from the Chat SDK`);

      const task = await waitForChatTask(ctx, message.ts);
      expect(task.source === "chat", `Chat SDK task ${task.id} has source ${task.source}`);
      // `swarm#<id>` pins the task to this scenario's lead: earlier scenarios registered
      // other leads that hold pending tasks, and a poll would claim one of those instead.
      expect(
        task.agentId === leadId,
        `Chat SDK task ${task.id} went to ${task.agentId}, not the pinned lead ${leadId}`,
      );

      await claim(ctx, leadId, task.id);
      const output = "Hello from the Chat SDK E2E worker.";
      await finish(ctx, leadId, task.id, { status: "completed", output });

      const reply = await waitForOutcome(flip.ctx, message.ts, output);
      expect(
        reply.bot_id === flip.mock.bot.botId,
        `Chat SDK reply came from ${String(reply.bot_id)}, expected the bot`,
      );
      expect(
        reply.thread_ts === message.ts,
        `Chat SDK replied on thread ${String(reply.thread_ts)}, expected ${message.ts}`,
      );
      await expectHttpTransport(ctx, flip, CHAT_SDK_SLACK_WEBHOOK);
    } finally {
      await flip.undo();
    }
  },
};
