import {
  getApprovalRequestById,
  getCompletedStepNodeIds,
  getDbClient,
  getStuckApprovalRuns,
  getStuckWaitRuns,
  getStuckWorkflowRuns,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  resolveApprovalRequest,
  updateWorkflowRun,
} from "../be/db";
import { getSettledChildRunParentSteps } from "../be/db/workflow-runs";
import type { WorkflowRunStep } from "../types";
import { shapeApprovalResolution } from "./approval-resolution";
import { loadCompletedStepRouting } from "./completed-step-routing";
import { FAILED_TASK_OUTPUT_PREFIX } from "./constants";
import {
  failRunOnUnreadableReplay,
  findReadyNodes,
  isWorkflowRunActive,
  walkGraph,
} from "./engine";
import type { ExecutorRegistry } from "./executors/registry";
import { getSecretInputKeys } from "./input";
import { finalizeOrWait, resumeFromChildRun, resumeWaitState } from "./resume";
import {
  checkpointPortStepAndResolveSuccessors,
  completeTaskStepAndResolveSuccessors,
  failStepAndRunIfWaiting,
  scheduleTaskStepRetry,
} from "./task-step-routing";

/**
 * Recover incomplete workflow runs on startup and during heartbeat sweeps.
 *
 * Two cases:
 * 1. `running` runs without a live graph walk — interrupted execution.
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

  // --- Case 4: Waiting runs whose wait_states are overdue or already resolved ---
  recovered += await recoverWaitStates(registry);

  // --- Case 5: Waiting sub-workflow steps whose child run already finished ---
  for (const parentStepId of await getSettledChildRunParentSteps()) {
    try {
      if (await resumeFromChildRun(parentStepId, registry)) recovered++;
    } catch (err) {
      console.error(`[workflows] Failed to resume sub-workflow step ${parentStepId}:`, err);
    }
  }

  if (recovered > 0) {
    console.log(`[workflows] Recovered ${recovered} incomplete run(s)`);
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
  const runningRunIds = await getRunIdsByStatus("running");
  let recovered = 0;

  for (const runId of runningRunIds) {
    try {
      if (isWorkflowRunActive(runId)) continue;
      const run = await getWorkflowRun(runId);
      if (!run || run.status !== "running") continue;

      const workflow = await getWorkflow(run.workflowId);
      if (!workflow) continue;

      const completedNodeIds = new Set(await getCompletedStepNodeIds(runId));
      const ctx = (run.context ?? {}) as Record<string, unknown>;

      // Rebuild the same selected-port edges as the live walker. Structural
      // successors include untaken branches and can replay completed joins.
      const { activeEdges } = await loadCompletedStepRouting(
        workflow.definition,
        runId,
        completedNodeIds,
      );
      // A node waiting for its retry belongs to the retry poller; walking it
      // here would execute it again next to the poller's retry.
      const retryPending = retryPendingNodeIds(await getWorkflowRunStepsByRunId(runId));
      const readyNodes = findReadyNodes(workflow.definition, completedNodeIds, activeEdges).filter(
        (node) => !retryPending.has(node.id),
      );
      // DB reads above yield; a trigger/resume may have acquired the run meanwhile.
      if (isWorkflowRunActive(runId)) continue;
      if (readyNodes.length === 0) {
        // Nothing is ready: complete the run from a snapshot read in the
        // same transaction as the write.
        if (!(await completeIfSettled(runId, ctx))) continue;
      } else {
        const secretKeys = getSecretInputKeys(workflow.input);
        await walkGraph(
          workflow.definition,
          runId,
          ctx,
          readyNodes,
          registry,
          workflow.id,
          secretKeys,
        );
      }
      recovered++;
    } catch (err) {
      if (await failRunOnUnreadableReplay(runId, err)) continue;
      console.error(`[workflows] Failed to recover running run ${runId}:`, err);
    }
  }

  return recovered;
}

/** Nodes with a failed step the retry poller will pick up (`nextRetryAt` set). */
function retryPendingNodeIds(steps: WorkflowRunStep[]): Set<string> {
  const nodeIds = new Set<string>();
  for (const step of steps) {
    if (step.status === "failed" && step.nextRetryAt != null) nodeIds.add(step.nodeId);
  }
  return nodeIds;
}

/**
 * Complete a running run that has nothing ready, in one transaction, only when
 * no step is live or waiting for its retry. Only each node's latest step
 * counts as live, so a `running` row a crash left behind, or the `pending` row
 * a user retry leaves before inserting its new step, does not park the run.
 */
async function completeIfSettled(runId: string, ctx: Record<string, unknown>): Promise<boolean> {
  return getDbClient().transaction(async () => {
    const run = await getWorkflowRun(runId);
    if (run?.status !== "running") return false;
    const steps = await getWorkflowRunStepsByRunId(runId);
    if (retryPendingNodeIds(steps).size > 0) return false;
    const latest = new Map<string, WorkflowRunStep>();
    for (const step of steps) latest.set(step.nodeId, step);
    for (const step of latest.values()) {
      if (step.status === "running" || step.status === "waiting" || step.status === "pending") {
        return false;
      }
    }
    await updateWorkflowRun(runId, {
      status: "completed",
      context: ctx,
      finishedAt: new Date().toISOString(),
    });
    return true;
  });
}

/**
 * Check waiting runs whose linked tasks may have completed/failed/cancelled
 * while the server was down.
 */
async function recoverWaitingRuns(registry: ExecutorRegistry): Promise<number> {
  const stuckRuns = await getStuckWorkflowRuns();
  let recovered = 0;

  for (const stuck of stuckRuns) {
    try {
      const run = await getWorkflowRun(stuck.runId);
      const workflow = await getWorkflow(stuck.workflowId);
      if (!run || run.status !== "waiting" || !workflow) continue;

      const taskCompleted = stuck.taskStatus === "completed";
      if (stuck.taskStatus === "failed") {
        // Same retry policy as the live task.failed handler: this sweep can
        // reach a failed task first, and must not bypass the node's retry.
        // `stuck` is a snapshot: the live handler and retry poller may have
        // redriven the step to a new task since, so every claim below is
        // fenced on `stuck.taskId` still being the task bound to the step.
        const failedStep = await getWorkflowRunStep(stuck.stepId);
        if (!failedStep) continue;
        const retry = await scheduleTaskStepRetry(
          workflow.definition,
          stuck.runId,
          failedStep,
          stuck.taskId,
          "Task failed (recovered)",
        );
        if (retry === "scheduled") recovered++;
        if (retry !== "not-eligible") continue;
      }
      if (!taskCompleted && (workflow.definition.onNodeFailure ?? "fail") === "fail") {
        // Preserve the fail-fast recovery policy for failed/cancelled tasks.
        // Claimed: this sweep runs on every heartbeat, so the live task.failed
        // bus event may already have routed this step — a blind write here
        // would kill a run that is already advancing.
        const reason =
          stuck.taskStatus === "failed" ? "Task failed (recovered)" : "Task cancelled (recovered)";
        const claimed = await failStepAndRunIfWaiting(
          stuck.stepId,
          stuck.runId,
          reason,
          stuck.taskId,
        );
        if (!claimed) continue;
        recovered++;
        continue;
      }

      const ctx = (run.context ?? {}) as Record<string, unknown>;
      const reason =
        stuck.taskStatus === "failed" ? "Task failed (recovered)" : "Task cancelled (recovered)";
      const stepOutput = {
        taskId: stuck.taskId,
        taskOutput: taskCompleted
          ? parseRecoveredTaskOutput(stuck.taskOutput)
          : `${FAILED_TASK_OUTPUT_PREFIX} ${reason}] This node failed or was cancelled.`,
      };
      const step = await getWorkflowRunStep(stuck.stepId);
      if (!step) continue;
      const routing = await completeTaskStepAndResolveSuccessors(
        workflow.definition,
        stuck.runId,
        step,
        stepOutput,
        ctx,
        taskCompleted ? undefined : reason,
        stuck.taskId,
      );
      if (!routing.claimed) continue;
      if (routing.foreachChild && !routing.joined) {
        // The parent remains waiting until another child closes the join.
        await finalizeOrWait(stuck.runId);
      } else {
        // Always walk normal-task successors, even when empty, so walkGraph's
        // finalization tail persists context and partial/retry failure state.
        const secretKeys = getSecretInputKeys(workflow.input);
        await walkGraph(
          workflow.definition,
          stuck.runId,
          ctx,
          routing.successors,
          registry,
          workflow.id,
          secretKeys,
        );
      }
      recovered++;
    } catch (err) {
      if (await failRunOnUnreadableReplay(stuck.runId, err)) continue;
      console.error(`[workflows] Failed to recover waiting run ${stuck.runId}:`, err);
    }
  }

  return recovered;
}

function parseRecoveredTaskOutput(output: string | null): unknown {
  // Keep recovery output parsing aligned with the live task-completion path.
  if (output === null) return null;
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === "object" && parsed !== null ? parsed : output;
  } catch {
    return output;
  }
}

/**
 * Recover waiting runs whose linked approval requests have resolved or expired
 * while the server was down.
 */
async function recoverApprovalWaitingRuns(registry: ExecutorRegistry): Promise<number> {
  const stuckRuns = await getStuckApprovalRuns();
  let recovered = 0;

  for (const stuck of stuckRuns) {
    try {
      const run = await getWorkflowRun(stuck.runId);
      const workflow = await getWorkflow(stuck.workflowId);
      if (!run || !workflow) continue;

      const ctx = (run.context ?? {}) as Record<string, unknown>;

      // The timeout write, the status re-read, and the step claim share 1
      // transaction. A request cancelled or answered after the sweep snapshot
      // routes on its current status, or not at all.
      const routing = await getDbClient().transaction(async () => {
        // If still pending but expired, mark as timeout
        if (stuck.approvalStatus === "pending" && stuck.expiresAt) {
          await resolveApprovalRequest(stuck.approvalId, {
            status: "timeout",
            resolutionReason: `Timed out: no answer before ${stuck.expiresAt}`,
          });
        }

        const approval = await getApprovalRequestById(stuck.approvalId);
        const approvalStatus = approval?.status;
        // A cancelled approval belongs to the run cancel path, never to a port.
        if (
          approvalStatus !== "approved" &&
          approvalStatus !== "rejected" &&
          approvalStatus !== "timeout"
        ) {
          return null;
        }

        const { output: stepOutput, nextPort } = shapeApprovalResolution(
          registry,
          workflow.definition,
          stuck.nodeId,
          (await getWorkflowRunStep(stuck.stepId))?.output,
          {
            requestId: stuck.approvalId,
            status: approvalStatus,
            responses: (approval?.responses ?? null) as Record<string, unknown> | null,
          },
        );

        // Use port-based routing to determine correct successors. Claimed: the
        // live approval.resolved bus event may have routed this step between
        // the sweep snapshot and here — routing it twice would create duplicate
        // successor steps and duplicate spawned tasks.
        return await checkpointPortStepAndResolveSuccessors(
          workflow.definition,
          stuck.runId,
          stuck.stepId,
          stuck.nodeId,
          stepOutput,
          nextPort,
          ctx,
        );
      });
      if (!routing?.claimed) continue;

      if (routing.successors.length > 0) {
        const secretKeys = getSecretInputKeys(workflow.input);
        await walkGraph(
          workflow.definition,
          stuck.runId,
          ctx,
          routing.successors,
          registry,
          workflow.id,
          secretKeys,
        );
      } else {
        await finalizeOrWait(stuck.runId);
      }
      recovered++;
    } catch (err) {
      if (await failRunOnUnreadableReplay(stuck.runId, err)) continue;
      console.error(`[workflows] Failed to recover approval-waiting run ${stuck.runId}:`, err);
    }
  }

  return recovered;
}

/**
 * Recover waiting runs whose `wait_states` rows are either already resolved
 * (case a — signal arrived / timeout fired while the API was down and the
 * in-memory bus event was lost) or pending-but-overdue (case b — `wakeUpAt`
 * or `expiresAt` already past; the wait poller would catch these on its first
 * tick, but explicit recovery avoids the up-to-5s startup latency window).
 *
 * Mirrors `recoverApprovalWaitingRuns`. Time-mode overdue rows resume as
 * `fired`. Event-mode overdue-but-pending rows resume as `timeout`. Already-
 * resolved rows resume with their stored status (and stored `firedPayload`
 * for fired event waits).
 */
async function recoverWaitStates(registry: ExecutorRegistry): Promise<number> {
  const stuckRuns = await getStuckWaitRuns();
  let recovered = 0;

  for (const stuck of stuckRuns) {
    try {
      // Decide what status to (re)apply.
      let resumeStatus: "fired" | "timeout";
      let payload: unknown;

      if (stuck.waitStatus === "fired") {
        resumeStatus = "fired";
        payload = stuck.firedPayload != null ? safeJsonParse(stuck.firedPayload) : undefined;
      } else if (stuck.waitStatus === "timeout") {
        resumeStatus = "timeout";
      } else {
        // pending + overdue
        resumeStatus = stuck.waitMode === "time" ? "fired" : "timeout";
      }

      await resumeWaitState(stuck.waitId, resumeStatus, payload, registry);
      recovered++;
    } catch (err) {
      if (await failRunOnUnreadableReplay(stuck.runId, err)) continue;
      console.error(`[workflows] Failed to recover wait-state ${stuck.waitId}:`, err);
    }
  }

  return recovered;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Get run IDs by status. Simple query since there's no dedicated function for this.
 */
async function getRunIdsByStatus(status: string): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>(
    "SELECT id FROM workflow_runs WHERE status = ?",
    [status],
  );
  return rows.map((r) => r.id);
}
