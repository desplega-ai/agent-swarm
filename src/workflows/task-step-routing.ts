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
