import { expect } from "../http";
import type { Scenario } from "../run";
import { postSigned } from "../slack-http";
import { ask, claim, findSlackTask, finish, registerLead, waitForEyes } from "./slack-helpers";
import {
  capturedEventFor,
  enableNativeHttp,
  slackReceipts,
  slackTasksForMessage,
  waitForNativeReady,
} from "./slack-http-helpers";

/**
 * An event the receiver stored keeps its dedupe key across an API restart: Slack's retry of it
 * after the restart is acked as a duplicate and creates no second task.
 */
export const slackHttpRestartRedelivery: Scenario = {
  name: "slack-http-restart-redelivery",
  order: 179.5,
  async run(ctx) {
    const flip = await enableNativeHttp(ctx);
    try {
      const leadId = await registerLead(flip.ctx, "e2e-lead-http-restart");
      const message = await ask(flip.ctx, `swarm#${leadId} survive a restart`);
      await waitForEyes(flip.ctx, message.ts);
      const task = await findSlackTask(flip.ctx, message.ts);
      const taskId = String(task.id);
      // Earlier leads in the run may hold the task, so claim as whoever it went to.
      const assignedId = typeof task.agentId === "string" ? task.agentId : leadId;
      const original = capturedEventFor(flip, message.ts);
      await flip.mock.flush();

      // The task is still pending: the restart's boot sweep fails only in-progress ones.
      await ctx.restartSut();
      await waitForNativeReady(ctx, flip);
      expect(
        ctx.slack.connectionCount === 0,
        "The restarted API opened a Socket Mode connection in HTTP mode",
      );
      const duplicatesBefore = (await slackReceipts(ctx)).duplicateDeliveries;

      const retry = await postSigned(ctx, flip.eventsUrl, flip.signingSecret, original.body, {
        headers: { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" },
      });
      expect(retry.status === 200, `Retry after the restart got ${retry.status}, expected 200`);
      await Bun.sleep(2_000);
      expect(
        (await slackReceipts(ctx)).duplicateDeliveries === duplicatesBefore + 1,
        "The retry after the restart was not counted as a duplicate delivery",
      );
      const tasks = slackTasksForMessage(ctx, message.ts);
      expect(
        tasks.length === 1 && tasks[0]?.id === taskId,
        `The retry left ${tasks.length} tasks for the thread, expected the original only`,
      );

      await claim(flip.ctx, assignedId, taskId);
      await finish(flip.ctx, assignedId, taskId, { status: "completed", output: "survived" });
    } finally {
      await flip.undo();
    }
  },
};
