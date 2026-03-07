import {
  getStuckWorkflowRuns,
  getWorkflow,
  getWorkflowRun,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { getSuccessors, walkDag } from "./engine";

export async function recoverStuckWorkflowRuns(): Promise<number> {
  const stuckRuns = getStuckWorkflowRuns();
  let recovered = 0;

  for (const stuck of stuckRuns) {
    try {
      const run = getWorkflowRun(stuck.runId);
      const workflow = getWorkflow(stuck.workflowId);
      if (!run || !workflow) continue;

      if (stuck.taskStatus === "completed") {
        // Resume — same logic as the event bus handler
        updateWorkflowRunStep(stuck.stepId, {
          status: "completed",
          output: { taskOutput: stuck.taskOutput },
          finishedAt: new Date().toISOString(),
        });
        const ctx = (run.context ?? {}) as Record<string, unknown>;
        ctx[stuck.nodeId] = { taskOutput: stuck.taskOutput };
        updateWorkflowRun(stuck.runId, { status: "running", context: ctx });
        const successors = getSuccessors(workflow.definition, stuck.nodeId, "default");
        await walkDag(workflow.definition, stuck.runId, ctx, successors);
      } else {
        // Task failed or cancelled — mark run failed
        const reason = stuck.taskStatus === "failed" ? "Task failed" : "Task cancelled";
        updateWorkflowRunStep(stuck.stepId, {
          status: "failed",
          error: reason,
          finishedAt: new Date().toISOString(),
        });
        updateWorkflowRun(stuck.runId, {
          status: "failed",
          error: reason,
          finishedAt: new Date().toISOString(),
        });
      }
      recovered++;
    } catch (err) {
      console.error(`[workflows] Failed to recover stuck run ${stuck.runId}:`, err);
    }
  }
  return recovered;
}
