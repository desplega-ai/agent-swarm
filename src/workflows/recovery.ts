import {
  getCompletedStepNodeIds,
  getDb,
  getStuckApprovalRuns,
  getStuckWorkflowRuns,
  getWorkflow,
  getWorkflowRun,
  resolveApprovalRequest,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import { findReadyNodes, walkGraph } from "./engine";
import type { ExecutorRegistry } from "./executors/registry";
import { finalizeOrWait } from "./resume";

/**
 * Recover incomplete workflow runs on server startup.
 *
 * Two cases:
 * 1. `running` runs — were mid-execution when server died.
 *    Find completed steps, compute ready nodes, continue walking.
 * 2. `waiting` runs — were waiting for a task that may have finished while we were down.
 *    Check if the linked task is done and resume/fail accordingly.
 */
export async function recoverIncompleteRuns(registry: ExecutorRegistry): Promise<number> {
  let recovered = 0;

  // --- Case 1: Running runs that were interrupted mid-execution ---
  recovered += await recoverRunningRuns(registry);

  // --- Case 2: Waiting runs whose tasks may have finished ---
  recovered += await recoverWaitingRuns(registry);

  // --- Case 3: Waiting runs whose approval requests may have resolved ---
  recovered += await recoverApprovalWaitingRuns(registry);

  if (recovered > 0) {
    console.log(`[workflows] Recovered ${recovered} incomplete run(s) on startup`);
  }

  return recovered;
}

/**
 * Resume runs that were in "running" state when the server stopped.
 * Uses checkpointed step data to find where to continue.
 */
async function recoverRunningRuns(registry: ExecutorRegistry): Promise<number> {
  // Query for all running runs by scanning steps
  // We need to find runs where status = 'running' and figure out which nodes to resume
  const runningRunIds = getRunIdsByStatus("running");
  let recovered = 0;

  for (const runId of runningRunIds) {
    try {
      const run = getWorkflowRun(runId);
      if (!run || run.status !== "running") continue;

      const workflow = getWorkflow(run.workflowId);
      if (!workflow) continue;

      const completedNodeIds = new Set(getCompletedStepNodeIds(runId));
      const ctx = (run.context ?? {}) as Record<string, unknown>;

      // Find the next nodes that are ready to execute
      const readyNodes = findReadyNodes(workflow.definition, completedNodeIds);
      if (readyNodes.length === 0) {
        // All nodes completed or nothing is ready — mark as completed
        updateWorkflowRun(runId, {
          status: "completed",
          context: ctx,
          finishedAt: new Date().toISOString(),
        });
      } else {
        await walkGraph(workflow.definition, runId, ctx, readyNodes, registry, workflow.id);
      }
      recovered++;
    } catch (err) {
      console.error(`[workflows] Failed to recover running run ${runId}:`, err);
    }
  }

  return recovered;
}

/**
 * Check waiting runs whose linked tasks may have completed/failed/cancelled
 * while the server was down.
 */
async function recoverWaitingRuns(registry: ExecutorRegistry): Promise<number> {
  const stuckRuns = getStuckWorkflowRuns();
  let recovered = 0;

  for (const stuck of stuckRuns) {
    try {
      const run = getWorkflowRun(stuck.runId);
      const workflow = getWorkflow(stuck.workflowId);
      if (!run || !workflow) continue;

      if (stuck.taskStatus === "completed") {
        // Task finished while we were down — checkpoint and resume
        const ctx = (run.context ?? {}) as Record<string, unknown>;
        const stepOutput = { taskId: stuck.stepId, taskOutput: stuck.taskOutput };

        checkpointStep(stuck.runId, stuck.stepId, stuck.nodeId, { output: stepOutput }, ctx);
        updateWorkflowRun(stuck.runId, { status: "running" });

        const successors = getSuccessors(workflow.definition, stuck.nodeId, "default");
        await walkGraph(workflow.definition, stuck.runId, ctx, successors, registry, workflow.id);
      } else {
        // Task failed or cancelled — mark run failed
        const reason =
          stuck.taskStatus === "failed" ? "Task failed (recovered)" : "Task cancelled (recovered)";
        const now = new Date().toISOString();
        updateWorkflowRunStep(stuck.stepId, {
          status: "failed",
          error: reason,
          finishedAt: now,
        });
        updateWorkflowRun(stuck.runId, {
          status: "failed",
          error: reason,
          finishedAt: now,
        });
      }
      recovered++;
    } catch (err) {
      console.error(`[workflows] Failed to recover waiting run ${stuck.runId}:`, err);
    }
  }

  return recovered;
}

/**
 * Recover waiting runs whose linked approval requests have resolved or expired
 * while the server was down.
 */
async function recoverApprovalWaitingRuns(registry: ExecutorRegistry): Promise<number> {
  const stuckRuns = getStuckApprovalRuns();
  let recovered = 0;

  for (const stuck of stuckRuns) {
    try {
      const run = getWorkflowRun(stuck.runId);
      const workflow = getWorkflow(stuck.workflowId);
      if (!run || !workflow) continue;

      let approvalStatus = stuck.approvalStatus;
      let responses: unknown = stuck.approvalResponses ? JSON.parse(stuck.approvalResponses) : null;

      // If still pending but expired, auto-reject
      if (approvalStatus === "pending" && stuck.expiresAt) {
        resolveApprovalRequest(stuck.approvalId, {
          status: "timeout",
        });
        approvalStatus = "timeout";
        responses = null;
      }

      const nextPort =
        approvalStatus === "timeout"
          ? "timeout"
          : approvalStatus === "rejected"
            ? "rejected"
            : "approved";

      const ctx = (run.context ?? {}) as Record<string, unknown>;
      const stepOutput = {
        requestId: stuck.approvalId,
        status: approvalStatus,
        responses,
      };

      checkpointStep(
        stuck.runId,
        stuck.stepId,
        stuck.nodeId,
        { output: stepOutput, nextPort },
        ctx,
      );
      updateWorkflowRun(stuck.runId, { status: "running" });

      // Use port-based routing to determine correct successors
      const successors = getSuccessors(workflow.definition, stuck.nodeId, nextPort);

      if (successors.length > 0) {
        await walkGraph(workflow.definition, stuck.runId, ctx, successors, registry, workflow.id);
      } else {
        finalizeOrWait(stuck.runId);
      }
      recovered++;
    } catch (err) {
      console.error(`[workflows] Failed to recover approval-waiting run ${stuck.runId}:`, err);
    }
  }

  return recovered;
}

/**
 * Get run IDs by status. Simple query since there's no dedicated function for this.
 */
function getRunIdsByStatus(status: string): string[] {
  const rows = getDb()
    .prepare<{ id: string }, [string]>("SELECT id FROM workflow_runs WHERE status = ?")
    .all(status);
  return rows.map((r) => r.id);
}
