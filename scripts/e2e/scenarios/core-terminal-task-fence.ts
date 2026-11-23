import { sql } from "../db";
// A session whose task already ended keeps store-progress and read-only tools, and loses writes.
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  cancelQuietly,
  claimTask,
  createAssignedTask,
  expectToolError,
  expectToolOk,
  registerWorker,
} from "./core-helpers";

export const coreTerminalTaskFence: Scenario = {
  name: "core-terminal-task-fence",
  order: 227,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "fence");
    const targetId = await registerWorker(ctx, "fence-target");
    const taskId = await createAssignedTask(ctx, agentId, `fence running ${ctx.nonce}`);
    await claimTask(ctx, agentId, taskId);
    const conn = await ctx.connectMcp(agentId, { headers: { "X-Source-Task-Id": taskId } });
    const cleanup: string[] = [taskId];
    try {
      // Control: while the task runs, the same session may delegate.
      const sent = await expectToolOk(conn, "send-task", {
        agentId: targetId,
        routingReason: "skill",
        routingNote: "fence control",
        task: `fence control child ${ctx.nonce}`,
      });
      cleanup.push(String(asRecord(sent.data.task).id));

      const superseded = await ctx.api("POST", `/api/tasks/${taskId}/supersede`, {
        agentId,
        body: { reason: "manual_supersede" },
      });
      expectStatus(superseded, [200], "supersede the running task");
      const resumeId = asRecord(superseded.json).resumeTaskId;
      if (typeof resumeId === "string") cleanup.push(resumeId);

      const lateText = `fence late child ${ctx.nonce}`;
      await expectToolError(
        conn,
        "send-task",
        {
          agentId: targetId,
          routingReason: "skill",
          routingNote: "late fence call",
          task: lateText,
        },
        "superseded",
      );
      await expectToolError(
        conn,
        "slack-reply",
        { taskId, message: `late reply ${ctx.nonce}` },
        "superseded",
      );
      const leaked = ctx.db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM agent_tasks WHERE task = ${lateText}`,
      );
      expect(leaked?.n === 0, "The refused send-task still created a task");

      await expectToolOk(conn, "store-progress", { taskId, progress: `late note ${ctx.nonce}` });
      await expectToolOk(conn, "get-task-details", { taskId });
    } finally {
      await conn.close();
      for (const id of cleanup) await cancelQuietly(ctx, id);
    }
  },
};
