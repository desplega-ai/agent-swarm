import {
  detachTaskFromWorkflowRunStep,
  getDbClient,
  getTaskById,
  getWorkflowRun,
  getWorkflowRunStep,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import {
  type RetryPolicy,
  RetryPolicySchema,
  SUPERSEDED_WORKFLOW_TASK_REASON,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRunStep,
} from "../types";
import { checkpointStep, checkpointStepFailure } from "./checkpoint";
import { getSuccessors } from "./definition";
import { joinForeach, resolveForeachParent } from "./foreach-join";

export interface PortStepRoutingResult {
  /** False when the step was already claimed or its run is terminal. */
  claimed: boolean;
  successors: WorkflowNode[];
}

/**
 * True while `taskId` is still the task bound to `stepId`. A retry detaches
 * the failed task and the poller binds a fresh one to the same step, so a
 * caller holding an older snapshot (the recovery sweep) can find the step
 * `waiting` again on a task it never saw. Call inside the claim transaction.
 */
async function isTaskBoundToStep(taskId: string, stepId: string): Promise<boolean> {
  const task = await getTaskById(taskId);
  return task?.workflowRunStepId === stepId;
}

/**
 * Atomically fail a waiting step and its run. Returns false when another
 * handler already moved the step out of `waiting` — the same task terminal
 * event can reach both the live bus listener and a recovery sweep, and a
 * blind write here would stomp a run another handler is already advancing.
 * With `ownerTaskId`, also returns false when that task is no longer the one
 * bound to the step (a stale snapshot of a step that was since redriven).
 */
export async function failStepAndRunIfWaiting(
  stepId: string,
  runId: string,
  reason: string,
  ownerTaskId?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  return await getDbClient().transaction(async () => {
    const current = await getWorkflowRunStep(stepId);
    if (!current || current.status !== "waiting") return false;
    if (ownerTaskId && !(await isTaskBoundToStep(ownerTaskId, stepId))) return false;
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
    const run = await getWorkflowRun(runId);
    if (!run || (run.status !== "waiting" && run.status !== "running")) {
      return { claimed: false, successors: [] };
    }
    await checkpointStep(runId, stepId, nodeId, { output, nextPort }, ctx);
    await updateWorkflowRun(runId, { status: "running" });
    return { claimed: true, successors: getSuccessors(def, nodeId, nextPort) };
  });
}

/**
 * Outcome of `scheduleTaskStepRetry`:
 * - `scheduled`: the step is queued for the retry poller; the caller stops.
 * - `not-claimed`: another handler already moved the step out of `waiting`,
 *   or the failed task is no longer the one bound to the step (it was
 *   already retried and a fresh task now owns it); the caller stops.
 * - `not-eligible`: no retry applies (no `node.retry` and not a supersede
 *   cut, not an agent-task node, or retries exhausted); the caller applies
 *   `onNodeFailure` as before.
 */
export type TaskStepRetryOutcome = "scheduled" | "not-claimed" | "not-eligible";

/**
 * Retry applied to an agent-task step whose task was cut by a supersede
 * (deploy drain, heartbeat remediation) when the node declares no `retry`.
 * The cut is not the task's fault, so the step gets one fresh attempt after
 * the restart settles. An explicit `node.retry` always wins; `retry:
 * { maxRetries: 0 }` opts a node with external side effects out.
 */
export const SUPERSEDE_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  strategy: "static",
  baseDelayMs: 30_000,
  maxDelayMs: 30_000,
};

/**
 * Apply a node's `retry` policy to a FAILED agent-task step task. The sync
 * executor path does this in `executeStep`; an async agent-task step only
 * learns about the failure here, from `task.failed` or the recovery sweep.
 * A node without `retry` gets `SUPERSEDE_RETRY_POLICY` when the task was
 * failed with `SUPERSEDED_WORKFLOW_TASK_REASON`. The task row is checked as
 * well as `reason`, because the recovery sweep passes its own reason text.
 *
 * In one transaction: re-claim the step while it is still `waiting` AND still
 * bound to the failed task, detach that task (the executor reuses any task
 * bound to the step, so a bound failed task would park the retry forever), and
 * record the failure with `nextRetryAt` so the retry poller re-dispatches a new
 * task. Bounded by `maxRetries` via the step's persisted `retryCount`, read
 * only after ownership is confirmed: a stale caller's step snapshot may carry
 * the counter of a newer attempt.
 *
 * Foreach children (`<foreachId>#<key>`) are not matched here: the retry
 * poller resolves nodes by exact id and cannot re-dispatch a child yet.
 */
export async function scheduleTaskStepRetry(
  def: WorkflowDefinition,
  runId: string,
  step: WorkflowRunStep,
  taskId: string,
  reason: string,
): Promise<TaskStepRetryOutcome> {
  const node = def.nodes.find((n) => n.id === step.nodeId);
  if (!node || node.type !== "agent-task") return "not-eligible";
  let policy: RetryPolicy;
  if (node.retry) {
    const parsed = RetryPolicySchema.safeParse(node.retry);
    if (!parsed.success) return "not-eligible";
    policy = parsed.data;
  } else {
    if (!(await isSupersedeCut(taskId, reason))) return "not-eligible";
    policy = SUPERSEDE_RETRY_POLICY;
  }

  return await getDbClient().transaction(async (): Promise<TaskStepRetryOutcome> => {
    const current = await getWorkflowRunStep(step.id);
    if (!current || current.status !== "waiting") return "not-claimed";
    if (!(await isTaskBoundToStep(taskId, step.id))) return "not-claimed";
    if (current.retryCount >= policy.maxRetries) return "not-eligible";
    await detachTaskFromWorkflowRunStep(taskId);
    await checkpointStepFailure(runId, step.id, reason, current.retryCount, policy);
    return "scheduled";
  });
}

async function isSupersedeCut(taskId: string, reason: string): Promise<boolean> {
  if (reason === SUPERSEDED_WORKFLOW_TASK_REASON) return true;
  const task = await getTaskById(taskId);
  return task?.failureReason === SUPERSEDED_WORKFLOW_TASK_REASON;
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
  ownerTaskId?: string,
): Promise<TaskStepRoutingResult> {
  // The task step, optional foreach join checkpoint, workflow context, and
  // running status must commit together. A crash after this transaction is
  // recoverable through the running-run graph re-walk.
  return await getDbClient().transaction(async (): Promise<TaskStepRoutingResult> => {
    // Re-read inside the transaction: callers checked `waiting` before their
    // own awaits, so the claim is only authoritative here.
    const current = await getWorkflowRunStep(step.id);
    if (!current || current.status !== "waiting") return UNCLAIMED;
    // A stale snapshot of a step since redriven to a fresh task must not route it.
    if (ownerTaskId && !(await isTaskBoundToStep(ownerTaskId, step.id))) return UNCLAIMED;

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
