import {
  cancelPendingApprovalRequestsForRun,
  cancelTask,
  getCompletedStepNodeIds,
  getDbClient,
  getPendingEventWaitNames,
  getPendingWaitsByEvent,
  getTaskByWorkflowRunStepId,
  getWaitStateById,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  listCancelledApprovalRequestsForRun,
  listCancelledApprovalRequestsForStep,
  resolveWaitState,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { getChildWorkflowRunId } from "../be/db/workflow-runs";
import type { WaitStateRow } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type ApprovalSlackClient,
  postApprovalCancellationUpdates,
} from "./approval-notifications";
import { shapeApprovalResolution } from "./approval-resolution";
import { loadCompletedStepRouting } from "./completed-step-routing";
import { FAILED_TASK_OUTPUT_PREFIX } from "./constants";
import { getNextTargets } from "./definition";
import { failRunOnUnreadableReplay, findReadyNodes, hasRunningStep, walkGraph } from "./engine";
import type { WorkflowEventBus } from "./event-bus";
import { workflowEventBus } from "./event-bus";
import type { ExecutorRegistry } from "./executors/registry";
import { childRunOutcome } from "./executors/sub-workflow";
import { computeNextPort } from "./executors/wait";
import { resolveForeachParent } from "./foreach-join";
import { getSecretInputKeys } from "./input";
import { findWorkflowReadinessProblems, formatReadinessProblems } from "./readiness";
import {
  checkpointPortStepAndResolveSuccessors,
  completeTaskStepAndResolveSuccessors,
  failStepAndRunIfWaiting,
  scheduleTaskStepRetry,
} from "./task-step-routing";
import { matchesFilter } from "./wait-filter";

interface TaskEvent {
  taskId: string;
  output?: string;
  agentId?: string;
  workflowRunId?: string;
  workflowRunStepId?: string;
  failureReason?: string;
}

interface ApprovalEvent {
  requestId: string;
  status: "approved" | "rejected" | "timeout" | "cancelled";
  responses: Record<string, unknown> | null;
  workflowRunId?: string;
  workflowRunStepId?: string;
}

/**
 * Wire up event bus listeners for workflow resume on task lifecycle events.
 *
 * Returns a teardown that detaches every handler this call attached. The
 * server never calls it, but tests attaching to the process-wide singleton
 * bus MUST call it in their afterAll: `bun test` runs every file in one
 * process, and a listener left on the singleton resumes runs in later files'
 * databases — it claims their waiting steps with a registry whose executors
 * don't exist there, silently stranding steps in `running`.
 */
export function setupWorkflowResumeListener(
  eventBus: WorkflowEventBus,
  registry: ExecutorRegistry,
): () => void {
  const onTaskCompleted = async (data: unknown) => {
    try {
      const event = data as TaskEvent;
      if (!event.workflowRunId || !event.workflowRunStepId) return;
      await resumeFromTaskCompletion(event, registry);
    } catch (err) {
      console.error("[workflows] Resume from task completion failed:", err);
    }
  };
  eventBus.on("task.completed", onTaskCompleted);

  const onTaskFailed = async (data: unknown) => {
    try {
      const event = data as TaskEvent;
      if (!event.workflowRunId || !event.workflowRunStepId) return;
      await handleTaskFailure(event, event.failureReason ?? "Task failed", registry, {
        retryable: true,
      });
    } catch (err) {
      console.error("[workflows] Handle task failure error:", err);
    }
  };
  eventBus.on("task.failed", onTaskFailed);

  const onTaskCancelled = async (data: unknown) => {
    try {
      const event = data as TaskEvent;
      if (!event.workflowRunId || !event.workflowRunStepId) return;
      await handleTaskFailure(event, "Task was cancelled", registry, { retryable: false });
    } catch (err) {
      console.error("[workflows] Handle task cancellation error:", err);
    }
  };
  eventBus.on("task.cancelled", onTaskCancelled);

  const onApprovalResolved = async (data: unknown) => {
    try {
      const event = data as ApprovalEvent;
      if (!event.workflowRunId || !event.workflowRunStepId) return;
      await resumeFromApprovalResolution(event, registry);
    } catch (err) {
      console.error("[workflows] Resume from approval resolution failed:", err);
    }
  };
  eventBus.on("approval.resolved", onApprovalResolved);

  const onChildRunFinished = async (data: unknown) => {
    try {
      const { parentStepId } = data as { parentStepId?: string };
      if (!parentStepId) return;
      await resumeFromChildRun(parentStepId, registry);
    } catch (err) {
      console.error("[workflows] Resume from child workflow run failed:", err);
    }
  };
  eventBus.on("workflow.child.finished", onChildRunFinished);

  return () => {
    eventBus.off("task.completed", onTaskCompleted);
    eventBus.off("task.failed", onTaskFailed);
    eventBus.off("task.cancelled", onTaskCancelled);
    eventBus.off("approval.resolved", onApprovalResolved);
    eventBus.off("workflow.child.finished", onChildRunFinished);
  };
}

/**
 * Run one live resume of a waiting step. A sealed replay copy that cannot be
 * opened fails the step and its run now, instead of logging and leaving the
 * run `waiting` until a recovery sweep. Any other error rethrows.
 */
async function failClosedOnUnreadableReplay(
  runId: string,
  stepId: string,
  resume: () => Promise<void>,
): Promise<void> {
  try {
    await resume();
  } catch (err) {
    if (!(await failRunOnUnreadableReplay(runId, err, stepId))) throw err;
  }
}

/**
 * Resume a workflow after a linked task completes.
 *
 * 1. Verify run and step are in "waiting" state
 * 2. Checkpoint step completion with task output
 * 3. Set run status to "running"
 * 4. Find successors and continue the graph walk
 */
async function resumeFromTaskCompletion(
  event: TaskEvent,
  registry: ExecutorRegistry,
): Promise<void> {
  await failClosedOnUnreadableReplay(event.workflowRunId!, event.workflowRunStepId!, () =>
    resumeFromTaskCompletionUnguarded(event, registry),
  );
}

async function resumeFromTaskCompletionUnguarded(
  event: TaskEvent,
  registry: ExecutorRegistry,
): Promise<void> {
  const run = await getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = await getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;
  if (await isStaleTaskEvent(step.id, event)) return;

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) return;

  // Checkpoint: atomic step completion + context update
  const ctx = (run.context ?? {}) as Record<string, unknown>;

  // JSON-parse structured output so downstream nodes can access nested fields
  let taskOutput: unknown = event.output;
  if (event.output) {
    try {
      const parsed = JSON.parse(event.output);
      if (typeof parsed === "object" && parsed !== null) {
        taskOutput = parsed;
      }
    } catch {
      // Not JSON — keep as string (non-structured output tasks)
    }
  }
  const stepOutput = { taskId: event.taskId, taskOutput };

  const routing = await completeTaskStepAndResolveSuccessors(
    workflow.definition,
    run.id,
    step,
    stepOutput,
    ctx,
  );
  // Another handler already routed this step — routing it twice would create
  // duplicate successor steps.
  if (!routing.claimed) return;

  // Use direct successor-based routing (same as resumeFromApprovalResolution).
  // findReadyNodes is NOT loop-aware — it excludes nodes with any completed step,
  // which breaks loop workflows where a node needs re-execution on a new iteration.
  // walkGraph handles convergence internally via activeEdges reconstruction.
  const successors = routing.successors;

  if (successors.length > 0) {
    const secretKeys = getSecretInputKeys(workflow.input);
    await walkGraph(
      workflow.definition,
      run.id,
      ctx,
      successors,
      registry,
      workflow.id,
      secretKeys,
    );
  } else {
    await finalizeOrWait(run.id);
  }
}

/**
 * If no nodes are ready and no steps are still waiting, finalize the run.
 * Otherwise set it back to waiting for the next task completion.
 */
export async function finalizeOrWait(runId: string): Promise<void> {
  // Snapshot and status write must commit together: a concurrent branch can
  // move a step into `waiting` between the read and the write, and a run
  // finalized from a stale snapshot strands that branch.
  await getDbClient().transaction(async () => {
    const steps = await getWorkflowRunStepsByRunId(runId);
    // A branch still executing belongs to a live walk, which finalizes the
    // run itself; its finalizer only acts on a `running` run.
    if (hasRunningStep(steps)) {
      const run = await getWorkflowRun(runId);
      if (run?.status === "waiting") await updateWorkflowRun(runId, { status: "running" });
      return;
    }
    // A step queued for the retry poller is still live, like a waiting one.
    const hasWaiting = steps.some(
      (s) => s.status === "waiting" || (s.status === "failed" && s.nextRetryAt != null),
    );
    if (hasWaiting) {
      await updateWorkflowRun(runId, { status: "waiting" });
    } else {
      // All steps done (completed or failed) — finalize the run
      await updateWorkflowRun(runId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });
    }
  });
}

/**
 * Handle task failure/cancellation.
 * A failed (never cancelled) task of an agent-task node with `retry` and
 * attempts left is re-dispatched through the retry poller first.
 * Otherwise the workflow's onNodeFailure config applies:
 * 'fail' (default): mark the entire run as failed.
 * 'continue': treat as completed with error output, let convergence proceed.
 */
async function handleTaskFailure(
  event: TaskEvent,
  reason: string,
  registry: ExecutorRegistry,
  options: { retryable: boolean },
): Promise<void> {
  await failClosedOnUnreadableReplay(event.workflowRunId!, event.workflowRunStepId!, () =>
    handleTaskFailureUnguarded(event, reason, registry, options),
  );
}

async function handleTaskFailureUnguarded(
  event: TaskEvent,
  reason: string,
  registry: ExecutorRegistry,
  options: { retryable: boolean },
): Promise<void> {
  const run = await getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = await getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;
  if (await isStaleTaskEvent(step.id, event)) return;

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) return;

  if (options.retryable) {
    const retry = await scheduleTaskStepRetry(
      workflow.definition,
      run.id,
      step,
      event.taskId,
      reason,
    );
    if (retry === "scheduled") {
      console.log(
        `[workflows] Task ${event.taskId} failed; step ${step.nodeId} of run ${run.id} queued for retry ${step.retryCount + 1}`,
      );
      return;
    }
    if (retry === "not-claimed") return;
  }

  const onFailure = workflow.definition.onNodeFailure ?? "fail";

  if (onFailure === "fail") {
    await markRunFailed(event, reason);
    return;
  }

  // "continue": treat as completed with error output
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  const stepOutput = {
    taskId: event.taskId,
    taskOutput: `${FAILED_TASK_OUTPUT_PREFIX} ${reason}] This node failed or was cancelled.`,
  };
  const routing = await completeTaskStepAndResolveSuccessors(
    workflow.definition,
    run.id,
    step,
    stepOutput,
    ctx,
    reason,
  );
  if (!routing.claimed) return;

  // Use direct successor-based routing (loop-aware).
  const successors = routing.successors;

  if (successors.length > 0) {
    const secretKeys = getSecretInputKeys(workflow.input);
    await walkGraph(
      workflow.definition,
      run.id,
      ctx,
      successors,
      registry,
      workflow.id,
      secretKeys,
    );
  } else {
    await finalizeOrWait(run.id);
  }
}

/**
 * A retried step has a NEW task bound to it. Task lifecycle events are emitted
 * from several places (the db mutators' after-commit emits, test/manual emits,
 * crash-recovery echoes) and can arrive on a later tick — after the step was
 * reset and re-dispatched. An event whose taskId no longer matches the task
 * currently bound to the step must not complete or fail a step it doesn't own.
 */
async function isStaleTaskEvent(stepId: string, event: TaskEvent): Promise<boolean> {
  if (!event.taskId) return false;
  const boundTask = await getTaskByWorkflowRunStepId(stepId);
  return boundTask != null && boundTask.id !== event.taskId;
}

/**
 * Mark a workflow run as failed when its linked task fails or is cancelled.
 * Claims the step inside a transaction: `task.failed` and `task.cancelled`
 * both route here and can also race a recovery sweep or a completion that
 * already claimed the step — only the first writer may fail the run.
 */
async function markRunFailed(event: TaskEvent, reason: string): Promise<void> {
  await failStepAndRunIfWaiting(event.workflowRunStepId!, event.workflowRunId!, reason);
}

/**
 * Retry a failed workflow run from its failed step.
 */
export async function retryFailedRun(runId: string, registry: ExecutorRegistry): Promise<void> {
  const run = await getWorkflowRun(runId);
  if (!run || run.status !== "failed") throw new Error("Run is not in failed state");

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) throw new Error("Workflow not found");

  // Find the failed step
  const steps = await getWorkflowRunStepsByRunId(runId);
  const failedStep = steps.find((s) => s.status === "failed");
  if (!failedStep) throw new Error("No failed step found");

  const completedNodeIds = new Set(await getCompletedStepNodeIds(runId));

  // A retry re-executes the failed node and everything after it. Refuse before the
  // run is reset when a node still to run cannot run (say, a system-one-decision node with no API
  // key), so the retry does not repeat side effects only to fail again downstream.
  const notReady = await findWorkflowReadinessProblems(
    { nodes: workflow.definition.nodes.filter((node) => !completedNodeIds.has(node.id)) },
    registry,
  );
  if (notReady.length > 0) {
    throw new Error(`Retry not started, run left failed: ${formatReadinessProblems(notReady)}`);
  }

  const { activeEdges } = await loadCompletedStepRouting(
    workflow.definition,
    runId,
    completedNodeIds,
  );
  const foreachParent = resolveForeachParent(workflow.definition, failedStep.nodeId);
  const failedNode =
    foreachParent ?? workflow.definition.nodes.find((n) => n.id === failedStep.nodeId);
  if (!failedNode) throw new Error(`Node ${failedStep.nodeId} not found in workflow definition`);
  const hasStructuralPredecessor = workflow.definition.nodes.some(
    (node) => node.next && getNextTargets(node.next).includes(failedNode.id),
  );
  const hasActivePredecessor = [...activeEdges].some((edge) => edge.endsWith(`→${failedNode.id}`));
  const shouldRetryFailedNode =
    foreachParent != null || !hasStructuralPredecessor || hasActivePredecessor;

  // Reset step and run. Claimed inside a transaction: two concurrent retries
  // (HTTP route + MCP tool) both pass the guard above, and a double reset
  // walks the same failed node twice.
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  const claimed = await getDbClient().transaction(async () => {
    const current = await getWorkflowRun(runId);
    if (!current || current.status !== "failed") return false;
    await updateWorkflowRunStep(failedStep.id, {
      status: shouldRetryFailedNode ? "pending" : "cancelled",
      error: shouldRetryFailedNode ? null : "Skipped on retry because its branch was not active",
    });
    await updateWorkflowRun(runId, { status: "running", error: null, context: ctx });
    return true;
  });
  if (!claimed) throw new Error("Run is not in failed state");

  // Resume from the failed node — use findReadyNodes for convergence safety.
  // findReadyNodes returns every node without a completed step, including a
  // branch whose step is still running or waiting on its task. That branch is
  // not the retry's to run: walking it again executes it twice.
  const liveNodeIds = new Set(
    steps.filter((s) => s.status === "running" || s.status === "waiting").map((s) => s.nodeId),
  );
  const readyNodes = findReadyNodes(workflow.definition, completedNodeIds, activeEdges).filter(
    (n) => n.id === failedNode.id || !liveNodeIds.has(n.id),
  );

  // Loop and foreach retry targets can be absent from readyNodes even when
  // active; include them explicitly, but never revive an untaken branch.
  const nodesToRun =
    !shouldRetryFailedNode || readyNodes.some((n) => n.id === failedNode.id)
      ? readyNodes
      : [failedNode, ...readyNodes];
  const secretKeys = getSecretInputKeys(workflow.input);
  await walkGraph(workflow.definition, runId, ctx, nodesToRun, registry, workflow.id, secretKeys);
}

/**
 * The DB writes of a run cancel, with no Slack post. Returns false when the
 * run is missing or already terminal. Called inside a caller's transaction,
 * the writes join it (as a SAVEPOINT) and commit or roll back with it.
 */
export async function cancelWorkflowRunRows(runId: string, cancelReason: string): Promise<boolean> {
  const terminalStatuses = ["completed", "failed", "cancelled", "skipped"];
  const now = new Date().toISOString();

  // Step snapshot, task cancels, and both status writes commit together so a
  // step created after the snapshot cannot survive the cancel and a
  // concurrent cancel cannot interleave. Task lifecycle events queue behind
  // this transaction's COMMIT (afterCommit) and drop on rollback.
  return await getDbClient().transaction(async () => {
    const current = await getWorkflowRun(runId);
    if (!current || terminalStatuses.includes(current.status)) return false;

    // Cancel non-terminal steps and their associated tasks
    const steps = await getWorkflowRunStepsByRunId(runId);
    for (const step of steps) {
      if (terminalStatuses.includes(step.status)) continue;

      // Cancel any task linked to this step
      const task = await getTaskByWorkflowRunStepId(step.id);
      if (task) {
        await cancelTask(task.id, cancelReason);
      }

      await updateWorkflowRunStep(step.id, {
        status: "cancelled",
        error: cancelReason,
        finishedAt: now,
      });
    }

    await cancelPendingApprovalRequestsForRun(runId, cancelReason);

    // Mark the run itself as cancelled
    await updateWorkflowRun(runId, {
      status: "cancelled",
      error: cancelReason,
      finishedAt: now,
    });
    return true;
  });
}

/**
 * Cancel a workflow run and all its non-terminal steps.
 * Also cancels any in-progress tasks spawned by waiting/running steps.
 */
export async function cancelWorkflowRun(runId: string, reason?: string): Promise<void> {
  const run = await getWorkflowRun(runId);
  if (!run) throw new Error("Workflow run not found");

  const terminalStatuses = ["completed", "failed", "cancelled", "skipped"];
  if (terminalStatuses.includes(run.status) && run.status !== "cancelled") {
    throw new Error(`Cannot cancel run in '${run.status}' state`);
  }

  const cancelReason = reason ?? "Cancelled by user";
  const applied = await cancelWorkflowRunRows(runId, cancelReason);

  // The migration trigger also catches direct step cancellation. Re-read after
  // commit so its rows are included alongside the run-wide sweep.
  const cancelledApprovals = await listCancelledApprovalRequestsForRun(runId);
  const latestRun = await getWorkflowRun(runId);
  if (!applied && latestRun?.status !== "cancelled") {
    throw new Error(`Cannot cancel run in '${latestRun?.status ?? "missing"}' state`);
  }
  await postApprovalCancellationUpdates(
    cancelledApprovals,
    applied ? cancelReason : (latestRun?.error ?? cancelReason),
  );
}

/** Cancel one HITL step and close any approval request it gates. */
export async function cancelWorkflowRunStep(
  stepId: string,
  reason = "Cancelled by user",
  slackClient?: ApprovalSlackClient,
): Promise<void> {
  const now = new Date().toISOString();
  let persistedReason = reason;
  await getDbClient().transaction(async () => {
    const step = await getWorkflowRunStep(stepId);
    if (!step) throw new Error("Workflow run step not found");
    if (step.nodeType !== "human-in-the-loop") {
      throw new Error("Only human-in-the-loop steps have an approval cancellation lifecycle");
    }
    if (["completed", "failed", "skipped"].includes(step.status)) {
      throw new Error(`Cannot cancel step in '${step.status}' state`);
    }
    if (step.status === "cancelled") {
      persistedReason = step.error ?? reason;
      return;
    }

    const task = await getTaskByWorkflowRunStepId(stepId);
    if (task) await cancelTask(task.id, reason);
    await updateWorkflowRunStep(stepId, {
      status: "cancelled",
      error: reason,
      finishedAt: now,
    });
  });

  const approvals = await listCancelledApprovalRequestsForStep(stepId);
  await postApprovalCancellationUpdates(approvals, persistedReason, slackClient);
}

/**
 * Resume a workflow after a linked approval request is resolved.
 *
 * 1. Verify run and step are in "waiting" state
 * 2. Checkpoint step completion with approval response data
 * 3. Route to the appropriate port (approved/rejected/timeout)
 * 4. Continue the graph walk
 */
async function resumeFromApprovalResolution(
  event: ApprovalEvent,
  registry: ExecutorRegistry,
): Promise<void> {
  await failClosedOnUnreadableReplay(event.workflowRunId!, event.workflowRunStepId!, () =>
    resumeFromApprovalResolutionUnguarded(event, registry),
  );
}

async function resumeFromApprovalResolutionUnguarded(
  event: ApprovalEvent,
  registry: ExecutorRegistry,
): Promise<void> {
  const run = await getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = await getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) return;

  if (event.status === "cancelled") {
    console.warn(
      `[workflows] approval ${event.requestId} is cancelled; step ${event.workflowRunStepId} stays waiting for the run cancel path`,
    );
    return;
  }

  // Opens the sealed replay context: after the cancelled bail-out, which leaves
  // the step to the run cancel path.
  const ctx = (run.context ?? {}) as Record<string, unknown>;

  // Output and port for the approval status. A step parked by an executor other
  // than human-in-the-loop shapes its own (see shapeApprovalResolution).
  const { output: stepOutput, nextPort } = shapeApprovalResolution(
    registry,
    workflow.definition,
    step.nodeId,
    step.output,
    { requestId: event.requestId, status: event.status, responses: event.responses },
  );

  // Use port-based routing to determine the correct successors.
  // findReadyNodes without activeEdges would return ALL structural successors
  // (e.g. both "success" and "generate-question"), ignoring the port selection.
  // Instead, compute the port-specific successors and let walkGraph handle
  // convergence checks via its internal activeEdges reconstruction.
  const routing = await checkpointPortStepAndResolveSuccessors(
    workflow.definition,
    run.id,
    step.id,
    step.nodeId,
    stepOutput,
    nextPort,
    ctx,
  );
  // Another handler (the recovery sweep) already routed this step — routing
  // it twice would create duplicate successor steps.
  if (!routing.claimed) return;
  const successors = routing.successors;

  if (successors.length > 0) {
    const secretKeys = getSecretInputKeys(workflow.input);
    await walkGraph(
      workflow.definition,
      run.id,
      ctx,
      successors,
      registry,
      workflow.id,
      secretKeys,
    );
  } else {
    await finalizeOrWait(run.id);
  }
}

/**
 * Resume a paused `wait` node. Single entry-point shared by the wait poller
 * (Phase 2 — time mode + event-mode timeout) and, in Phase 3, the bus listener
 * for event-mode signal arrival.
 *
 * Flow:
 *   1. Atomically resolve the `wait_states` row (`pending → fired|timeout`).
 *      Race-safe: `resolveWaitState` returns `{updated: false}` when a
 *      concurrent caller already won — we bail without further side-effects.
 *   2. Reload the run + step. Bail if the step is no longer in `waiting`
 *      (cancelled, failed, or somehow already advanced).
 *   3. Compute the output port (time → `default`, event+fired → `event`,
 *      event+timeout → `timeout`).
 *   4. Checkpoint the step as completed with the wait output, set the run
 *      back to `running`, and walk the successors of the chosen port.
 *
 * NOTE: there are intentionally NO `wait.fired` / `wait.timeout` bus events.
 * Resumption is an internal function call — the poller invokes this directly,
 * and the Phase 3 bus listener will too.
 */
export async function resumeWaitState(
  waitId: string,
  status: "fired" | "timeout",
  payload: unknown,
  registry: ExecutorRegistry,
): Promise<void> {
  // 1. Cap firedPayload at 64KB (DB-write boundary). Webhook payloads can be
  // 50KB+ — anything bigger is replaced with a marker so we don't bloat the
  // row. The same truncated form is also what the workflow sees in
  // `output.payload` so authors aren't surprised by stored vs delivered
  // diverging.
  const cappedPayload = capPayload(payload);

  // 2. Atomic state transition. Only the first caller proceeds.
  const result = await resolveWaitState(waitId, { status, firedPayload: cappedPayload });
  if (!result.updated || !result.row) return;

  const waitRow = result.row;
  await failClosedOnUnreadableReplay(waitRow.workflowRunId, waitRow.workflowRunStepId, () =>
    resumeClaimedWait(waitRow, status, cappedPayload, registry),
  );
}

async function resumeClaimedWait(
  waitRow: WaitStateRow,
  status: "fired" | "timeout",
  cappedPayload: unknown,
  registry: ExecutorRegistry,
): Promise<void> {
  // 2. Load the surrounding run + step. If anything has moved on (cancelled,
  // failed, retried, etc.), stay quiet.
  const run = await getWorkflowRun(waitRow.workflowRunId);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = await getWorkflowRunStep(waitRow.workflowRunStepId);
  if (!step || step.status !== "waiting") return;

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) return;

  // 3. Pick the output port.
  const nextPort = computeNextPort(waitRow.mode, status);

  // 4. Build step output, checkpoint, transition run, walk successors.
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  const stepOutput = {
    waitId: waitRow.id,
    mode: waitRow.mode,
    firedAt: waitRow.resolvedAt,
    payload: cappedPayload === undefined ? undefined : cappedPayload,
  };

  // The `waiting` checks above ran before getWorkflow's await. The wait-state
  // claim only arbitrates two resumeWaitState callers, not a user cancel
  // landing in that window (cancelWorkflowRun never touches wait_states), so
  // the authoritative claim is the in-transaction re-read of the step.
  const routing = await checkpointPortStepAndResolveSuccessors(
    workflow.definition,
    run.id,
    step.id,
    step.nodeId,
    stepOutput,
    nextPort,
    ctx,
  );
  if (!routing.claimed) return;

  // 5. Bus listener bookkeeping: this wait is no longer pending, so drop it
  // from the per-event subscription set. If the set empties out, unwire the
  // bus listener.
  if (waitRow.mode === "event" && waitRow.eventName) {
    pruneWaitFromBus(waitRow.id, waitRow.eventName);
  }

  const successors = routing.successors;
  if (successors.length > 0) {
    const secretKeys = getSecretInputKeys(workflow.input);
    await walkGraph(
      workflow.definition,
      run.id,
      ctx,
      successors,
      registry,
      workflow.id,
      secretKeys,
    );
  } else {
    await finalizeOrWait(run.id);
  }
}

/**
 * Resume a waiting `sub-workflow` step once its child run is terminal: a
 * completed child completes the step, any other end (or a deleted child) fails
 * the step and its run. Returns true when this call claimed the step. Safe to call repeatedly:
 * the live event and the recovery sweep both route here.
 */
export async function resumeFromChildRun(
  parentStepId: string,
  registry: ExecutorRegistry,
): Promise<boolean> {
  const step = await getWorkflowRunStep(parentStepId);
  if (!step || step.status !== "waiting" || step.nodeType !== "sub-workflow") return false;
  const childId = await getChildWorkflowRunId(parentStepId);
  const child = childId ? await getWorkflowRun(childId) : null;
  // The child row exists before the step parks, so a missing one was deleted.
  const outcome = child
    ? childRunOutcome(child)
    : { error: `Child workflow run of step ${parentStepId} was deleted` };
  if (!outcome) return false;

  let claimed = false;
  await failClosedOnUnreadableReplay(step.runId, step.id, async () => {
    const run = await getWorkflowRun(step.runId);
    if (!run || (run.status !== "waiting" && run.status !== "running")) return;
    const workflow = await getWorkflow(run.workflowId);
    if (!workflow) return;

    if ("error" in outcome) {
      claimed = await failStepAndRunIfWaiting(step.id, run.id, outcome.error);
      return;
    }

    const ctx = (run.context ?? {}) as Record<string, unknown>;
    const routing = await checkpointPortStepAndResolveSuccessors(
      workflow.definition,
      run.id,
      step.id,
      step.nodeId,
      outcome.output,
      "success",
      ctx,
    );
    if (!routing.claimed) return;
    claimed = true;

    if (routing.successors.length > 0) {
      const secretKeys = getSecretInputKeys(workflow.input);
      await walkGraph(
        workflow.definition,
        run.id,
        ctx,
        routing.successors,
        registry,
        workflow.id,
        secretKeys,
      );
    } else {
      await finalizeOrWait(run.id);
    }
  });
  return claimed;
}

// ─── 64KB firedPayload cap ──────────────────────────────────────────────────

const FIRED_PAYLOAD_BYTE_CAP = 64 * 1024; // 64KB

/**
 * Apply the 64KB cap policy to event-mode `firedPayload`. If the JSON-encoded
 * payload exceeds the cap, replace it with a structured truncation marker so
 * downstream nodes can detect the truncation and either ignore it or pull the
 * full payload from the source if needed.
 *
 * The same form flows into both the DB row AND the step output — see
 * docstring above for rationale.
 */
function capPayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return payload;
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    // Non-serializable (function, symbol, circular ref, …) — hand back a
    // marker rather than letting JSON.stringify failure bubble up.
    return { truncated: true, reason: "non-serializable" };
  }
  if (encoded.length <= FIRED_PAYLOAD_BYTE_CAP) {
    return payload;
  }
  // Build a 1KB summary slice for visibility.
  const summary = encoded.slice(0, 1024);
  return {
    truncated: true,
    originalSize: encoded.length,
    summary,
  };
}

// ─── Wait bus subscription registry (event mode) ────────────────────────────
//
// One bus listener per distinct `eventName`. Each listener iterates a Set of
// pending waitIds, looks up each row, applies scope + filter, and resolves on
// match. Listeners are created lazily (on first subscribeWaitToBus for an
// eventName) and torn down when the per-name Set empties.

const waitsByEvent = new Map<string, Set<string>>();
const listenersByEvent = new Map<string, (data: unknown) => void>();
let busRegistry: ExecutorRegistry | null = null;

/**
 * Initialize the wait-bus subscription system. Called from `initWorkflows()`
 * AFTER `setupWorkflowResumeListener`. Scans all pending event-mode waits and
 * registers one listener per distinct event name.
 *
 * Subsequent calls update the registry reference (idempotent — listeners
 * already registered are not re-registered).
 */
export async function initWaitBusSubscriptions(registry: ExecutorRegistry): Promise<void> {
  busRegistry = registry;
  // Pre-existing listeners are fine — they pick up the new registry via the
  // module-level `busRegistry` reference.
  // Recover pending event-mode waits from DB so signals fired pre-recovery
  // arrive at the right wait once the listener is registered.
  // We use a dedicated DB query rather than getPendingWaitsByEvent so we can
  // page through ALL distinct event names in one pass.
  const pendingNames = await collectPendingEventNames();
  for (const name of pendingNames) {
    const pending = await getPendingWaitsByEvent(name);
    for (const w of pending) {
      registerWait(w.id, name);
    }
  }
}

async function collectPendingEventNames(): Promise<Set<string>> {
  return new Set(await getPendingEventWaitNames());
}

/**
 * Add `waitId` to the subscription set for `eventName` and register the
 * listener if not already present. Idempotent — safe to call from
 * `WaitExecutor.execute`.
 */
export function subscribeWaitToBus(waitId: string, eventName: string): void {
  registerWait(waitId, eventName);
}

function registerWait(waitId: string, eventName: string): void {
  let set = waitsByEvent.get(eventName);
  if (!set) {
    set = new Set();
    waitsByEvent.set(eventName, set);
  }
  set.add(waitId);

  if (!listenersByEvent.has(eventName)) {
    const listener = (data: unknown) => {
      // Fire-and-forget: don't block the bus thread. Per-wait errors are
      // logged inside processBusEvent's loop, but the code around that loop
      // is not covered by it — and the emitter cannot observe this promise,
      // since EventEmitter discards whatever a listener returns.
      processBusEvent(eventName, data).catch((err) => {
        console.error(
          `[workflows] Wait bus listener failed for event=${eventName}:`,
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        );
      });
    };
    listenersByEvent.set(eventName, listener);
    workflowEventBus.on(eventName, listener);
  }
}

function pruneWaitFromBus(waitId: string, eventName: string): void {
  const set = waitsByEvent.get(eventName);
  if (!set) return;
  set.delete(waitId);
  if (set.size === 0) {
    waitsByEvent.delete(eventName);
    const listener = listenersByEvent.get(eventName);
    if (listener) {
      workflowEventBus.off(eventName, listener);
      listenersByEvent.delete(eventName);
    }
  }
}

/**
 * Bus listener body. Walks the per-event waitId set, applies scope + filter,
 * resolves on match. Race-safety lives inside `resumeWaitState`.
 */
async function processBusEvent(eventName: string, payload: unknown): Promise<void> {
  const set = waitsByEvent.get(eventName);
  if (!set || set.size === 0) return;
  if (!busRegistry) return; // Pre-init — drop the event silently.

  // Snapshot the set so we can mutate (prune) during iteration.
  const waitIds = [...set];
  for (const waitId of waitIds) {
    try {
      const row = await getWaitStateById(waitId);
      if (!row || row.status !== "pending") {
        // Already resolved (race) or vanished — drop the stale subscription.
        set.delete(waitId);
        continue;
      }

      // Scope enforcement: 'run' requires payload._runId or
      // payload.workflowRunId to match the wait's workflowRunId.
      if (row.eventScope === "run") {
        if (!isPayloadInRun(payload, row.workflowRunId)) continue;
      }

      // Filter match.
      const ok = await matchesFilter(payload, row.eventFilter ?? undefined);
      if (!ok) continue;

      // Resolve via the shared helper. Race-safe: only the first caller wins.
      await resumeWaitState(waitId, "fired", payload, busRegistry);
    } catch (err) {
      console.error(
        `[workflows] Wait bus listener failed for wait=${waitId} event=${eventName}:`,
        err,
      );
    }
  }

  // Clean up: if all waits for this event resolved, drop the listener.
  if (set.size === 0) {
    waitsByEvent.delete(eventName);
    const listener = listenersByEvent.get(eventName);
    if (listener) {
      workflowEventBus.off(eventName, listener);
      listenersByEvent.delete(eventName);
    }
  }
}

function isPayloadInRun(payload: unknown, runId: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const rec = payload as Record<string, unknown>;
  return rec._runId === runId || rec.workflowRunId === runId;
}

// Test-only: clear in-memory subscription state. Used by unit tests that
// mount/unmount the bus across describe blocks.
export function _resetWaitBusSubscriptionsForTests(): void {
  for (const [name, listener] of listenersByEvent.entries()) {
    workflowEventBus.off(name, listener);
  }
  listenersByEvent.clear();
  waitsByEvent.clear();
  busRegistry = null;
}
