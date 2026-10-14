import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  createChildTask,
  enableSlackRenderV2Only,
  expectNoWakeTime,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForOutcome,
} from "./slack-helpers";

// Auto-discovered by registry.ts, before delegation is enabled globally.
export const slackRedefer: Scenario = {
  name: "slack-redefer",
  order: 138,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await registerLead(ctx, "e2e-lead-redefer");
    const message = await ask(ctx, "wait for both staging checks before publishing");
    ctx.markThread("redefer", "C0GENERAL0", message.ts);
    await waitForEyes(ctx, message.ts);
    const task = await findSlackTask(ctx, message.ts);
    const taskId = String(task.id);
    const leadId = String(task.agentId);
    await claim(ctx, leadId, taskId);
    const firstCheck = await createChildTask(ctx, taskId, leadId, "First staging check");
    const thread = () =>
      ctx.slack.messages("general").filter((row) => row.thread_ts === message.ts);
    // Exclude the thread tree, which also contains a waiting glyph.
    const cards = () => thread().filter((row) => String(row.text ?? "").startsWith("⏳"));
    const mcp = await ctx.connectMcp(leadId);
    try {
      const deferred = await mcp.callTool("defer-task", {
        taskId,
        delayMs: 86_400_000,
        wakeOn: { event: "settled", taskId: firstCheck },
        summary: "Waiting for staging.",
        note: "Check the next staging result.",
      });
      expect(!deferred.isError, `Initial defer failed: ${JSON.stringify(deferred)}`);
      const card = await waitForOutcome(ctx, message.ts, "Waiting on e2e-lead-redefer");
      await ctx.slack.waitForApiCall("chat.stopStream", {
        timeoutMs: 30_000,
        where: (call) => call.args.ts === card.ts,
      });
      expect(
        cards().length === 1 && cards()[0]?.ts === card.ts,
        "Expected one initial waiting card",
      );
      const firstSchedule = ctx.db.get<{ nextRunAt: string }>(
        "SELECT nextRunAt FROM scheduled_tasks WHERE parentTaskId = ?",
        [taskId],
      );
      await claim(ctx, leadId, firstCheck);
      await finish(ctx, leadId, firstCheck, { status: "completed", output: "First check passed." });
      let wakeId: string | undefined;
      const woke = await pollUntil(async () => {
        const response = await ctx.api("GET", `/api/tasks?agentId=${leadId}&fields=full&limit=50`);
        expectStatus(response, [200], "find deferred wake-up");
        const tasks = asRecord(response.json).tasks;
        expect(Array.isArray(tasks), "Task list has no tasks array");
        const wake = tasks
          .map(asRecord)
          .find((row) => row.parentTaskId === taskId && row.taskType === "deferred");
        if (wake) wakeId = String(wake.id);
        return wakeId !== undefined;
      }, 15_000);
      expect(woke && wakeId, "Initial defer never woke");
      await claim(ctx, leadId, wakeId!);
      const secondCheck = await createChildTask(ctx, taskId, leadId, "Second staging check");
      const watcher = await createChildTask(ctx, taskId, leadId, "Duplicate staging watcher");
      const redeferred = await mcp.callTool("defer-task", {
        taskId: wakeId,
        delayMs: 172_800_000,
        wakeOn: { event: "settled", taskId: secondCheck },
        summary: "Still waiting for staging.",
        note: "Check the remaining staging result.",
      });
      expect(!redeferred.isError, `Re-defer failed: ${JSON.stringify(redeferred)}`);
      const nextSchedule = ctx.db.get<{ nextRunAt: string }>(
        "SELECT nextRunAt FROM scheduled_tasks WHERE parentTaskId = ?",
        [wakeId],
      );
      // Slack deliberately hides times; assert the changed ceiling in the stored schedules.
      expect(
        firstSchedule &&
          nextSchedule &&
          Date.parse(nextSchedule.nextRunAt) > Date.parse(firstSchedule.nextRunAt),
        "Re-defer must store the later wake time",
      );
      const updated = await ctx.slack.waitForApiCall("chat.update", {
        timeoutMs: 30_000,
        where: (call) => call.args.ts === card.ts && String(call.args.text ?? "").startsWith("⏳"),
      });
      expect(updated.ok === true, "Re-defer did not edit the original waiting card");
      const refused = await mcp.callTool("defer-task", {
        taskId: watcher,
        delayMs: 172_800_000,
        wakeOn: { event: "settled", taskId: secondCheck },
        summary: "Watch the same staging check.",
        note: "Wait for staging.",
      });
      expect(
        refused.isError === true && JSON.stringify(refused).includes("Pending watcher"),
        `Duplicate watcher was not refused: ${JSON.stringify(refused)}`,
      );
      const watcherState = await ctx.api("GET", `/api/tasks/${watcher}`);
      expectStatus(watcherState, [200], "read refused watcher");
      expect(
        asRecord(watcherState.json).status !== "completed",
        "Refused watcher must remain unfinished",
      );
      const duplicate = await pollUntil(
        () =>
          cards().length !== 1 ||
          cards()[0]?.ts !== card.ts ||
          JSON.stringify(thread()).includes("deferred again"),
        10_000,
      );
      expect(!duplicate, "Re-defer or refused watcher added a card or a redundant resume line");
      expectNoWakeTime(ctx, message.ts, "re-defer");
    } finally {
      await mcp.close();
    }
  },
};
