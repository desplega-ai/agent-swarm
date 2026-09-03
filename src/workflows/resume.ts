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
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type ApprovalSlackClient,
  postApprovalCancellationUpdates,
} from "./approval-notifications";
import { loadCompletedStepRouting } from "./completed-step-routing";
import { FAILED_TASK_OUTPUT_PREFIX } from "./constants";
import { getNextTargets } from "./definition";
import { findReadyNodes, walkGraph } from "./engine";
import type { WorkflowEventBus } from "./event-bus";
import { workflowEventBus } from "./event-bus";
import type { ExecutorRegistry } from "./executors/registry";
import { computeNextPort } from "./executors/wait";
import { resolveForeachParent } from "./foreach-join";
import { getSecretInputKeys } from "./input";
import {
  checkpointPortStepAndResolveSuccessors,
  completeTaskStepAndResolveSuccessors,
  failStepAndRunIfWaiting,
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
  status: "approved" | "rejected" | "timeout";
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
      await handleTaskFailure(event, event.failureReason ?? "Task failed", registry);
    } catch (err) {
      console.error("[workflows] Handle task failure error:", err);
    }
  };
  eventBus.on("task.failed", onTaskFailed);

  const onTaskCancelled = async (data: unknown) => {
    try {
      const event = data as TaskEvent;
      if (!event.workflowRunId || !event.workflowRunStepId) return;
      await handleTaskFailure(event, "Task was cancelled", registry);
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

  return () => {
    eventBus.off("task.completed", onTaskCompleted);
    eventBus.off("task.failed", onTaskFailed);
    eventBus.off("task.cancelled", onTaskCancelled);
    eventBus.off("approval.resolved", onApprovalResolved);
  };
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
    const hasWaiting = steps.some((s) => s.status === "waiting");
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
 * Handle task failure/cancellation — respects workflow's onNodeFailure config.
 * 'fail' (default): mark the entire run as failed.
 * 'continue': treat as completed with error output, let convergence proceed.
 */
async function handleTaskFailure(
  event: TaskEvent,
  reason: string,
  registry: ExecutorRegistry,
): Promise<void> {
  const run = await getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = await getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;
  if (await isStaleTaskEvent(step.id, event)) return;

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) return;

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
  const readyNodes = findReadyNodes(workflow.definition, completedNodeIds, activeEdges);

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

  const now = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";
  let applied = false;

  // Step snapshot, task cancels, and both status writes commit together so a
  // step created after the snapshot cannot survive the cancel and a
  // concurrent cancel cannot interleave. Task lifecycle events queue behind
  // this transaction's COMMIT (afterCommit) and drop on rollback.
  await getDbClient().transaction(async () => {
    const current = await getWorkflowRun(runId);
    if (!current || terminalStatuses.includes(current.status)) return;
    applied = true;

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
  });

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
  const run = await getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = await getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;

  const workflow = await getWorkflow(run.workflowId);
  if (!workflow) return;

  const ctx = (run.context ?? {}) as Record<string, unknown>;

  // Determine output port based on approval status
  const nextPort =
    event.status === "timeout" ? "timeout" : event.status === "rejected" ? "rejected" : "approved";

  const stepOutput = {
    requestId: event.requestId,
    status: event.status,
    responses: event.responses,
  };

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
