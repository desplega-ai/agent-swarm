import {
  getDbClient,
  getWorkflowRunStep,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { WorkflowDefinition, WorkflowNode, WorkflowRunStep } from "../types";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import { joinForeach, resolveForeachParent } from "./foreach-join";

export interface PortStepRoutingResult {
  /** False when another handler already moved the step out of `waiting`. */
  claimed: boolean;
  successors: WorkflowNode[];
}

/**
 * Atomically fail a waiting step and its run. Returns false when another
 * handler already moved the step out of `waiting` — the same task terminal
 * event can reach both the live bus listener and a recovery sweep, and a
 * blind write here would stomp a run another handler is already advancing.
 */
export async function failStepAndRunIfWaiting(
  stepId: string,
  runId: string,
  reason: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  return await getDbClient().transaction(async () => {
    const current = await getWorkflowRunStep(stepId);
    if (!current || current.status !== "waiting") return false;
    await updateWorkflowRunStep(stepId, {
      status: "failed",
      error: reason,
      finishedAt: now,
    });
    await updateWorkflowRun(runId, {
      status: "failed",
      error: reason,
      finishedAt: now,
    });
    return true;
  });
}

/**
 * Checkpoint a waiting step with a port-based result and resolve its
 * successors. Mirrors `completeTaskStepAndResolveSuccessors`: callers check
 * `waiting` before their own awaits, so the claim is only authoritative
 * inside this transaction — the same approval resolution reaching two resume
 * paths (bus event + recovery sweep) routes once.
 */
export async function checkpointPortStepAndResolveSuccessors(
  def: WorkflowDefinition,
  runId: string,
  stepId: string,
  nodeId: string,
  output: unknown,
  nextPort: string,
  ctx: Record<string, unknown>,
): Promise<PortStepRoutingResult> {
  return await getDbClient().transaction(async (): Promise<PortStepRoutingResult> => {
    const current = await getWorkflowRunStep(stepId);
    if (!current || current.status !== "waiting") return { claimed: false, successors: [] };
    await checkpointStep(runId, stepId, nodeId, { output, nextPort }, ctx);
    await updateWorkflowRun(runId, { status: "running" });
    return { claimed: true, successors: getSuccessors(def, nodeId, nextPort) };
  });
}

export interface TaskStepRoutingResult {
  /**
   * False when another handler already moved the step out of `waiting` — the
   * caller must not route successors again. The same task terminal event can
   * reach two resume paths (the DB-emitted bus event and a direct emit, or a
   * recovery sweep racing a live event); only the first one may route.
   */
  claimed: boolean;
  foreachChild: boolean;
  joined: boolean;
  successors: WorkflowNode[];
}

const UNCLAIMED: TaskStepRoutingResult = {
  claimed: false,
  foreachChild: false,
  joined: false,
  successors: [],
};

/**
 * Persist an agent-task result and resolve its next nodes. Synthetic foreach
 * children never checkpoint into workflow context; only their parent join does.
 */
export async function completeTaskStepAndResolveSuccessors(
  def: WorkflowDefinition,
  runId: string,
  step: WorkflowRunStep,
  output: unknown,
  ctx: Record<string, unknown>,
  failureReason?: string,
): Promise<TaskStepRoutingResult> {
  // The task step, optional foreach join checkpoint, workflow context, and
  // running status must commit together. A crash after this transaction is
  // recoverable through the running-run graph re-walk.
  return await getDbClient().transaction(async (): Promise<TaskStepRoutingResult> => {
    // Re-read inside the transaction: callers checked `waiting` before their
    // own awaits, so the claim is only authoritative here.
    const current = await getWorkflowRunStep(step.id);
    if (!current || current.status !== "waiting") return UNCLAIMED;

    const foreachParent = resolveForeachParent(def, step.nodeId);
    if (foreachParent) {
      await updateWorkflowRunStep(step.id, {
        status: "completed",
        output,
        // onNodeFailure:"continue" completions persist the failure reason as
        // explicit metadata — the join classifies children on THIS, not on
        // whether user-controlled output text happens to start with "[FAILED:".
        ...(failureReason !== undefined ? { error: failureReason } : {}),
        finishedAt: new Date().toISOString(),
      });
      const join = await joinForeach(def, runId, step, ctx);
      await updateWorkflowRun(runId, { status: "running" });
      return {
        claimed: true,
        foreachChild: true,
        joined: join.joined,
        successors: join.successors,
      };
    }

    await checkpointStep(runId, step.id, step.nodeId, { output }, ctx);
    await updateWorkflowRun(runId, { status: "running" });
    return {
      claimed: true,
      foreachChild: false,
      joined: true,
      successors: getSuccessors(def, step.nodeId),
    };
  });
}
