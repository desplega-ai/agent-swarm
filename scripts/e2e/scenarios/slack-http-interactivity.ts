import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { ask, claim, findSlackTask, registerLead, waitForEyes } from "./slack-helpers";
import { enableNativeHttp, expectNativeTransport } from "./slack-http-helpers";

/** A Cancel button click as a signed `block_actions` form post cancels the task and updates its card. */
export const slackHttpInteractivity: Scenario = {
  name: "slack-http-interactivity",
  order: 178,
  async run(ctx) {
    const flip = await enableNativeHttp(ctx);
    try {
      const slack = flip.mock;
      const leadId = await registerLead(flip.ctx, "e2e-lead-http-interactivity");
      const message = await ask(flip.ctx, "start something I will cancel");
      await waitForEyes(flip.ctx, message.ts);
      const task = await findSlackTask(flip.ctx, message.ts);
      const taskId = String(task.id);
      // Earlier leads in the run may hold the task, so claim as whoever it went to.
      const assignedId = typeof task.agentId === "string" ? task.agentId : leadId;
      await claim(flip.ctx, assignedId, taskId);

      // The watcher posts the task card with its Cancel button once the task is running.
      const isCard = (candidate: { thread_ts?: string; bot_id?: string }) =>
        candidate.thread_ts === message.ts && candidate.bot_id === slack.bot.botId;
      let cardTs: string | undefined;
      const found = await pollUntil(() => {
        const card = slack
          .messages("general")
          .find((m) => isCard(m) && JSON.stringify(m.blocks ?? []).includes('"cancel_task"'));
        cardTs = card?.ts;
        return cardTs !== undefined;
      }, 30_000);
      expect(found && cardTs, `No bot card with a cancel_task button in thread ${message.ts}`);

      const ack = await slack.clickButton({
        channel: "general",
        ts: cardTs as string,
        action_id: "cancel_task",
        value: taskId,
        user: "alice",
      });
      expect(ack.attempts === 1, `block_actions needed ${ack.attempts} delivery attempts`);

      const cancelled = await pollUntil(async () => {
        const response = await ctx.api("GET", `/api/tasks/${taskId}`);
        expectStatus(response, [200], `read task ${taskId} after the cancel click`);
        return asRecord(response.json).status === "cancelled";
      }, 15_000);
      expect(cancelled, `Task ${taskId} was not cancelled after the signed block_actions click`);
      const updated = await pollUntil(
        () =>
          /cancel/i.test(
            JSON.stringify(slack.messages("general").find((m) => m.ts === cardTs) ?? {}),
          ) &&
          !JSON.stringify(slack.messages("general").find((m) => m.ts === cardTs) ?? {}).includes(
            '"cancel_task"',
          ),
        15_000,
      );
      expect(updated, `The card ${cardTs} was not updated to the cancelled state`);
      await expectNativeTransport(ctx, flip);
    } finally {
      await flip.undo();
    }
  },
};
