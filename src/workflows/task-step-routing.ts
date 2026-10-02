import {
  detachTaskFromWorkflowRunStep,
  getDbClient,
  getWorkflowRunStep,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import {
  RetryPolicySchema,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRunStep,
} from "../types";
import { checkpointStep, checkpointStepFailure } from "./checkpoint";
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

/**
 * Outcome of `scheduleTaskStepRetry`:
 * - `scheduled`: the step is queued for the retry poller; the caller stops.
 * - `not-claimed`: another handler already moved the step out of `waiting`;
 *   the caller stops.
 * - `not-eligible`: no retry applies (no `node.retry`, not an agent-task node,
 *   or retries exhausted); the caller applies `onNodeFailure` as before.
 */
export type TaskStepRetryOutcome = "scheduled" | "not-claimed" | "not-eligible";

/**
 * Apply a node's `retry` policy to a FAILED agent-task step task. The sync
 * executor path does this in `executeStep`; an async agent-task step only
 * learns about the failure here, from `task.failed` or the recovery sweep.
 *
 * In one transaction: re-claim the step while it is still `waiting` on the
 * same attempt, detach the failed task (the executor reuses any task bound to
 * the step, so a bound failed task would park the retry forever), and record
 * the failure with `nextRetryAt` so the retry poller re-dispatches a new task.
 * Bounded by `maxRetries` via the step's persisted `retryCount`.
 */
export async function scheduleTaskStepRetry(
  def: WorkflowDefinition,
  runId: string,
  step: WorkflowRunStep,
  taskId: string,
  reason: string,
): Promise<TaskStepRetryOutcome> {
  const node = def.nodes.find((n) => n.id === step.nodeId);
  if (!node || node.type !== "agent-task" || !node.retry) return "not-eligible";
  const parsed = RetryPolicySchema.safeParse(node.retry);
  if (!parsed.success) return "not-eligible";
  const policy = parsed.data;
  if (step.retryCount >= policy.maxRetries) return "not-eligible";

  return await getDbClient().transaction(async (): Promise<TaskStepRetryOutcome> => {
    const current = await getWorkflowRunStep(step.id);
    if (!current || current.status !== "waiting") return "not-claimed";
    // The attempt counter moved under us: the step was already retried.
    if (current.retryCount !== step.retryCount) return "not-claimed";
    await detachTaskFromWorkflowRunStep(taskId);
    await checkpointStepFailure(runId, step.id, reason, current.retryCount, policy);
    return "scheduled";
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
