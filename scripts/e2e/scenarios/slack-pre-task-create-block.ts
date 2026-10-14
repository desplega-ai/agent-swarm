import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForBotReply,
  waitForReaction,
} from "./slack-helpers";

async function installBlockingTemplate(ctx: ScenarioContext): Promise<string> {
  const installed = await ctx.api("POST", "/api/extensions/install", {
    body: { template: "require-ticket-ref", config: { origins: ["slack"] } },
  });
  expectStatus(installed, [200], "install require-ticket-ref for Slack flush block");
  const id = asRecord(asRecord(installed.json).extension).id;
  expect(typeof id === "string", "Installed blocking extension has no id");
  const enabled = await ctx.api("POST", `/api/extensions/${id}/enable`);
  expectStatus(enabled, [200], "enable blocking extension");
  return id;
}

async function cleanupExtension(ctx: ScenarioContext, id: string): Promise<void> {
  const disabled = await ctx.api("POST", `/api/extensions/${id}/disable`);
  expectStatus(disabled, [200], "disable blocking extension");
  const removed = await ctx.api("DELETE", `/api/extensions/${id}`);
  expectStatus(removed, [200], "remove blocking extension");
}

export const slackPreTaskCreateBlock: Scenario = {
  name: "slack-pre-task-create-block",
  order: 175,
  async run(ctx) {
    let extensionId: string | undefined;
    try {
      // Create an existing task first so the next human reply goes through the
      // additive thread buffer rather than the top-level mention path.
      const leadId = await registerLead(ctx, `e2e-blocked-flush-lead-${ctx.nonce}`);
      const root = await ask(ctx, `start a thread for block test ${ctx.nonce}`);
      await waitForBotReply(ctx, root.ts);
      const rootTask = await findSlackTask(ctx, root.ts);
      const rootTaskId = String(rootTask.id);
      await claim(ctx, leadId, rootTaskId);
      await finish(ctx, leadId, rootTaskId, {
        status: "completed",
        output: "The original task is complete.",
      });

      extensionId = await installBlockingTemplate(ctx);
      const followUp = await ctx.slack.postMessage({
        channel: "general",
        user: "alice",
        thread_ts: root.ts,
        text: "please add this follow-up",
      });

      await waitForReaction(ctx, followUp.ts, "no_entry");

      const tasksResponse = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100");
      expectStatus(tasksResponse, [200], "list Slack tasks after blocked buffer flush");
      const tasks = asRecord(tasksResponse.json).tasks;
      expect(Array.isArray(tasks), "Slack task list has no tasks array");
      expect(
        !tasks.map(asRecord).some((task) => task.slackTriggerMessageTs === followUp.ts),
        "A task was created even though pre.task.create blocked the buffered follow-up",
      );

      // Wait past the normal debounce/flush window and ensure no standard
      // "batched into task" or "queued pending completion" feedback was posted.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      const threadMessages = ctx.slack
        .messages("general")
        .filter((message) => message.thread_ts === root.ts);
      expect(
        !threadMessages.some((message) =>
          /follow-up message\(s\) (?:batched into task|queued pending completion)/i.test(
            JSON.stringify(message),
          ),
        ),
        "Normal buffer-flush feedback was posted for a blocked task",
      );
    } finally {
      if (extensionId) await cleanupExtension(ctx, extensionId);
    }
  },
};
