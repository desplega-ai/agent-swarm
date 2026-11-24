import { insertionOrder, sql } from "../db";
// A crash between an agent-task step's task insert and the step parking leaves
// the step `running` with a live task. Recovery on the next boot must reconnect
// the step to that task, not insert a second one under a new step row.
import { expect, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  createWorkflow,
  outputOf,
  registerWorker,
  triggerWorkflow,
  waitForRun,
} from "./workflow-helpers";

type StepRow = { id: string; status: string };

export const workflowAgentTaskCrashWindow: Scenario = {
  name: "workflow-agent-task-crash-window",
  order: 326,
  async run(ctx) {
    const marker = `crash-window-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-crash-window");
    const workflowId = await createWorkflow(ctx, "wf-crash-window", {
      nodes: [
        {
          id: "work",
          type: "agent-task",
          config: { template: `Handle ${marker}`, agentId: workerId },
        },
      ],
    });
    const tasksOf = (runId: string) =>
      ctx.db.query<{ id: string }>(
        sql`SELECT id FROM agent_tasks WHERE "workflowRunId" = ${runId}`,
      );
    const stepsOf = (runId: string) =>
      ctx.db.query<StepRow>(
        sql`SELECT id, status FROM workflow_run_steps WHERE "runId" = ${runId} AND "nodeId" = 'work' ORDER BY ${insertionOrder}`,
      );

    // This process dies right after the step inserts its task.
    await ctx.restartSut({ env: { E2E_CRASH_AFTER_WORKFLOW_TASK_INSERT: marker } });
    const { runId } = await triggerWorkflow(ctx, workflowId, {}, { wait: false });
    const down = await pollUntil(
      async () => {
        try {
          await ctx.api("GET", "/health");
          return false;
        } catch {
          return true;
        }
      },
      30_000,
      100,
    );
    expect(down, "the API did not hit the crash point after the task insert");

    // Control: the crash landed in the window (task inserted, step not parked).
    const before = tasksOf(runId);
    const orphan = stepsOf(runId);
    expect(before.length === 1, `expected 1 task before recovery, got ${before.length}`);
    expect(
      orphan.length === 1 && orphan[0]?.status === "running",
      `expected one running step before recovery, got ${JSON.stringify(orphan)}`,
    );

    ctx.captureStateSurface("workflow-step-statuses");

    // The next boot recovers the run and parks the step on a task.
    await ctx.restartSut();
    const parked = await pollUntil(
      () => stepsOf(runId).some((step) => step.status === "waiting"),
      30_000,
      250,
    );
    expect(parked, `recovery never parked the step: ${JSON.stringify(stepsOf(runId))}`);

    const after = tasksOf(runId);
    expect(
      after.length === 1 && after[0]?.id === before[0]?.id,
      `recovery created a second task: ${JSON.stringify(after.map((t) => t.id))}`,
    );
    const steps = stepsOf(runId);
    expect(
      steps.length === 1 && steps[0]?.id === orphan[0]?.id,
      `recovery started a new step row instead of re-entering the orphan: ${JSON.stringify(steps)}`,
    );

    // The original task settles the run.
    await ctx.startAgent({ agentId: workerId });
    const detail = await waitForRun(ctx, runId, "completed");
    const output = outputOf(detail, "work");
    expect(
      output.taskId === before[0]?.id,
      `step completed on task ${String(output.taskId)}, not the original ${before[0]?.id}`,
    );
  },
};
