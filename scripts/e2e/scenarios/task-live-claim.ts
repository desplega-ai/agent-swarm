import { sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { claimTask, createAssignedTask, readTask, registerWorker } from "./core-helpers";

// A worker claims a task and keeps a live session on it: the task stays
// `in_progress` while the worker heartbeats. Every other scenario finishes or
// cancels the tasks it claims, and crash recovery reroutes a claimed task whose
// session went quiet, so this scenario runs last and leaves its claim live. The
// strict gate's `task-statuses` surface reads that row after the run.
export const taskLiveClaim: Scenario = {
  name: "task-live-claim",
  order: 9_990,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "live-claim");
    const text = `live claim task ${ctx.nonce}`;
    const taskId = await createAssignedTask(ctx, workerId, text);
    await claimTask(ctx, workerId, taskId);

    const response = await ctx.api("POST", "/api/active-sessions", {
      body: {
        agentId: workerId,
        taskId,
        triggerType: "task_assigned",
        taskDescription: text,
        runnerSessionId: `runner-live-${ctx.nonce}`,
      },
    });
    expectStatus(response, [201], "open the worker session on the claimed task");
    expect(asRecord(asRecord(response.json).session).taskId === taskId, "Session task id");
    const heartbeat = await ctx.api("PUT", `/api/active-sessions/heartbeat/${taskId}`, {
      agentId: workerId,
    });
    expectStatus(heartbeat, [200], "heartbeat the worker session");
    expect(asRecord(heartbeat.json).updated === true, "Heartbeat did not update the session");

    const task = await readTask(ctx, taskId);
    expect(task.status === "in_progress", `Task ${taskId} is ${String(task.status)}`);
    expect(task.agentId === workerId, `Task ${taskId} is held by ${String(task.agentId)}`);
    const row = ctx.db.get<{ status: string }>(
      sql`SELECT status FROM agent_tasks WHERE id = ${taskId}`,
    );
    expect(row?.status === "in_progress", `Stored status is ${String(row?.status)}`);
  },
};
