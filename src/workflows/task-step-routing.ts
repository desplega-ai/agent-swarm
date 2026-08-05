import { getDb, updateWorkflowRun, updateWorkflowRunStep } from "../be/db";
import type { WorkflowDefinition, WorkflowNode, WorkflowRunStep } from "../types";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import { joinForeach, resolveForeachParent } from "./foreach-join";

export interface TaskStepRoutingResult {
  foreachChild: boolean;
  joined: boolean;
  successors: WorkflowNode[];
}

/**
 * Persist an agent-task result and resolve its next nodes. Synthetic foreach
 * children never checkpoint into workflow context; only their parent join does.
 */
export function completeTaskStepAndResolveSuccessors(
  def: WorkflowDefinition,
  runId: string,
  step: WorkflowRunStep,
  output: unknown,
  ctx: Record<string, unknown>,
  failureReason?: string,
): TaskStepRoutingResult {
  const txn = getDb().transaction((): TaskStepRoutingResult => {
    const foreachParent = resolveForeachParent(def, step.nodeId);
    if (foreachParent) {
      updateWorkflowRunStep(step.id, {
        status: "completed",
        output,
        // onNodeFailure:"continue" completions persist the failure reason as
        // explicit metadata — the join classifies children on THIS, not on
        // whether user-controlled output text happens to start with "[FAILED:".
        ...(failureReason !== undefined ? { error: failureReason } : {}),
        finishedAt: new Date().toISOString(),
      });
      const join = joinForeach(def, runId, step, ctx);
      updateWorkflowRun(runId, { status: "running" });
      return {
        foreachChild: true,
        joined: join.joined,
        successors: join.successors,
      };
    }

    checkpointStep(runId, step.id, step.nodeId, { output }, ctx);
    updateWorkflowRun(runId, { status: "running" });
    return {
      foreachChild: false,
      joined: true,
      successors: getSuccessors(def, step.nodeId),
    };
  });

  // The task step, optional foreach join checkpoint, workflow context, and
  // running status must commit together. A crash after this transaction is
  // recoverable through the running-run graph re-walk.
  return txn();
}
