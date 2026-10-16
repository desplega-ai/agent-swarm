import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  registerLead,
  waitForBotReply,
  waitForEyes,
  waitForReaction,
} from "./slack-helpers";

async function setAdditiveSlack(ctx: ScenarioContext, enabled: boolean): Promise<void> {
  const priorConnections = ctx.slack.apiCalls("apps.connections.open").length;
  const response = await ctx.api("PUT", "/api/config", {
    body: {
      scope: "global",
      scopeId: null,
      key: "ADDITIVE_SLACK",
      value: String(enabled),
      isSecret: false,
    },
  });
  expectStatus(response, [200], `set ADDITIVE_SLACK=${enabled}`);
  const reconnected = await pollUntil(
    () => ctx.slack.apiCalls("apps.connections.open").length > priorConnections,
    15_000,
  );
  expect(reconnected, "Slack did not reconnect after updating ADDITIVE_SLACK");
}

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
    let restoreAdditiveSlack = false;
    try {
      const leadId = await registerLead(ctx, `e2e-blocked-flush-lead-${ctx.nonce}`);
      const root = await ask(ctx, `start a thread for block test ${ctx.nonce}`);
      await waitForBotReply(ctx, root.ts);
      const rootTask = await findSlackTask(ctx, root.ts);
      const rootTaskId = String(rootTask.id);
      await claim(ctx, leadId, rootTaskId);

      extensionId = await installBlockingTemplate(ctx);
      restoreAdditiveSlack = true;
      await setAdditiveSlack(ctx, true);
      const existingThreadMessageTimestamps = new Set(
        ctx.slack
          .messages("general")
          .filter((message) => message.thread_ts === root.ts)
          .map((message) => message.ts),
      );
      const followUp = await ctx.slack.postMessage({
        channel: "general",
        user: "alice",
        thread_ts: root.ts,
        text: "please add this follow-up",
      });

      await waitForEyes(ctx, followUp.ts);
      await waitForReaction(ctx, followUp.ts, "no_entry");

      const tasksResponse = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100");
      expectStatus(tasksResponse, [200], "list Slack tasks after blocked buffer flush");
      const tasks = asRecord(tasksResponse.json).tasks;
      expect(Array.isArray(tasks), "Slack task list has no tasks array");
      expect(
        !tasks.map(asRecord).some((task) => task.slackTriggerMessageTs === followUp.ts),
        "A task was created even though pre.task.create blocked the buffered follow-up",
      );

      const threadMessages = ctx.slack
        .messages("general")
        .filter((message) => message.thread_ts === root.ts);
      expect(
        threadMessages.every(
          (message) =>
            message.ts === followUp.ts || existingThreadMessageTimestamps.has(message.ts),
        ),
        "A feedback or tree message was posted for a blocked task",
      );
    } finally {
      try {
        if (restoreAdditiveSlack) await setAdditiveSlack(ctx, false);
      } finally {
        if (extensionId) await cleanupExtension(ctx, extensionId);
      }
    }
  },
};
