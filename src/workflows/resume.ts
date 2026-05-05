import {
  cancelTask,
  getCompletedStepNodeIds,
  getPendingEventWaitNames,
  getPendingWaitsByEvent,
  getTaskByWorkflowRunStepId,
  getWaitStateById,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  resolveWaitState,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import { findReadyNodes, walkGraph } from "./engine";
import type { WorkflowEventBus } from "./event-bus";
import { workflowEventBus } from "./event-bus";
import type { ExecutorRegistry } from "./executors/registry";
import { computeNextPort } from "./executors/wait";
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
 */
export function setupWorkflowResumeListener(
  eventBus: WorkflowEventBus,
  registry: ExecutorRegistry,
): void {
  eventBus.on("task.completed", async (data: unknown) => {
    const event = data as TaskEvent;
    if (!event.workflowRunId || !event.workflowRunStepId) return;
    try {
      await resumeFromTaskCompletion(event, registry);
    } catch (err) {
      console.error("[workflows] Resume from task completion failed:", err);
    }
  });

  eventBus.on("task.failed", async (data: unknown) => {
    const event = data as TaskEvent;
    if (!event.workflowRunId || !event.workflowRunStepId) return;
    try {
      await handleTaskFailure(event, event.failureReason ?? "Task failed", registry);
    } catch (err) {
      console.error("[workflows] Handle task failure error:", err);
    }
  });

  eventBus.on("task.cancelled", async (data: unknown) => {
    const event = data as TaskEvent;
    if (!event.workflowRunId || !event.workflowRunStepId) return;
    try {
      await handleTaskFailure(event, "Task was cancelled", registry);
    } catch (err) {
      console.error("[workflows] Handle task cancellation error:", err);
    }
  });

  eventBus.on("approval.resolved", async (data: unknown) => {
    const event = data as ApprovalEvent;
    if (!event.workflowRunId || !event.workflowRunStepId) return;
    try {
      await resumeFromApprovalResolution(event, registry);
    } catch (err) {
      console.error("[workflows] Resume from approval resolution failed:", err);
    }
  });
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
  const run = getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;

  const workflow = getWorkflow(run.workflowId);
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

  checkpointStep(run.id, step.id, step.nodeId, { output: stepOutput }, ctx);

  // Set run back to running
  updateWorkflowRun(run.id, { status: "running" });

  // Use direct successor-based routing (same as resumeFromApprovalResolution).
  // findReadyNodes is NOT loop-aware — it excludes nodes with any completed step,
  // which breaks loop workflows where a node needs re-execution on a new iteration.
  // walkGraph handles convergence internally via activeEdges reconstruction.
  const successors = getSuccessors(workflow.definition, step.nodeId);

  if (successors.length > 0) {
    await walkGraph(workflow.definition, run.id, ctx, successors, registry, workflow.id);
  } else {
    finalizeOrWait(run.id);
  }
}

/**
 * If no nodes are ready and no steps are still waiting, finalize the run.
 * Otherwise set it back to waiting for the next task completion.
 */
export function finalizeOrWait(runId: string): void {
  const steps = getWorkflowRunStepsByRunId(runId);
  const hasWaiting = steps.some((s) => s.status === "waiting");
  if (hasWaiting) {
    updateWorkflowRun(runId, { status: "waiting" });
  } else {
    // All steps done (completed or failed) — finalize the run
    updateWorkflowRun(runId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
  }
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
  const run = getWorkflowRun(event.workflowRunId!);
  if (!run) return;

  const workflow = getWorkflow(run.workflowId);
  if (!workflow) return;

  const onFailure = workflow.definition.onNodeFailure ?? "fail";

  if (onFailure === "fail") {
    markRunFailed(event, reason);
    return;
  }

  // "continue": treat as completed with error output
  const step = getWorkflowRunStep(event.workflowRunStepId!);
  if (!step) return;

  const ctx = (run.context ?? {}) as Record<string, unknown>;
  const stepOutput = {
    taskId: event.taskId,
    taskOutput: `[FAILED: ${reason}] This node failed or was cancelled.`,
  };
  checkpointStep(run.id, step.id, step.nodeId, { output: stepOutput }, ctx);

  updateWorkflowRun(run.id, { status: "running" });

  // Use direct successor-based routing (loop-aware).
  const successors = getSuccessors(workflow.definition, step.nodeId);

  if (successors.length > 0) {
    await walkGraph(workflow.definition, run.id, ctx, successors, registry, workflow.id);
  } else {
    finalizeOrWait(run.id);
  }
}

/**
 * Mark a workflow run as failed when its linked task fails or is cancelled.
 */
function markRunFailed(event: TaskEvent, reason: string): void {
  const now = new Date().toISOString();
  updateWorkflowRunStep(event.workflowRunStepId!, {
    status: "failed",
    error: reason,
    finishedAt: now,
  });
  updateWorkflowRun(event.workflowRunId!, {
    status: "failed",
    error: reason,
    finishedAt: now,
  });
}

/**
 * Retry a failed workflow run from its failed step.
 */
export async function retryFailedRun(runId: string, registry: ExecutorRegistry): Promise<void> {
  const run = getWorkflowRun(runId);
  if (!run || run.status !== "failed") throw new Error("Run is not in failed state");

  const workflow = getWorkflow(run.workflowId);
  if (!workflow) throw new Error("Workflow not found");

  // Find the failed step
  const steps = getWorkflowRunStepsByRunId(runId);
  const failedStep = steps.find((s) => s.status === "failed");
  if (!failedStep) throw new Error("No failed step found");

  // Reset step and run
  updateWorkflowRunStep(failedStep.id, { status: "pending", error: undefined });
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  updateWorkflowRun(runId, { status: "running", error: undefined, context: ctx });

  // Resume from the failed node — use findReadyNodes for convergence safety
  const completedNodeIds = new Set(getCompletedStepNodeIds(runId));
  const readyNodes = findReadyNodes(workflow.definition, completedNodeIds);
  const failedNode = workflow.definition.nodes.find((n) => n.id === failedStep.nodeId);
  if (!failedNode) throw new Error(`Node ${failedStep.nodeId} not found in workflow definition`);

  // Include the failed node if it's not already in ready nodes
  const nodesToRun = readyNodes.some((n) => n.id === failedNode.id)
    ? readyNodes
    : [failedNode, ...readyNodes];
  await walkGraph(workflow.definition, runId, ctx, nodesToRun, registry, workflow.id);
}

/**
 * Cancel a workflow run and all its non-terminal steps.
 * Also cancels any in-progress tasks spawned by waiting/running steps.
 */
export function cancelWorkflowRun(runId: string, reason?: string): void {
  const run = getWorkflowRun(runId);
  if (!run) throw new Error("Workflow run not found");

  const terminalStatuses = ["completed", "failed", "cancelled", "skipped"];
  if (terminalStatuses.includes(run.status)) {
    throw new Error(`Cannot cancel run in '${run.status}' state`);
  }

  const now = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";

  // Cancel non-terminal steps and their associated tasks
  const steps = getWorkflowRunStepsByRunId(runId);
  for (const step of steps) {
    if (terminalStatuses.includes(step.status)) continue;

    // Cancel any task linked to this step
    const task = getTaskByWorkflowRunStepId(step.id);
    if (task) {
      cancelTask(task.id, cancelReason);
    }

    updateWorkflowRunStep(step.id, {
      status: "cancelled",
      error: cancelReason,
      finishedAt: now,
    });
  }

  // Mark the run itself as cancelled
  updateWorkflowRun(runId, {
    status: "cancelled",
    error: cancelReason,
    finishedAt: now,
  });
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
  const run = getWorkflowRun(event.workflowRunId!);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;

  const workflow = getWorkflow(run.workflowId);
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

  checkpointStep(run.id, step.id, step.nodeId, { output: stepOutput, nextPort }, ctx);
  updateWorkflowRun(run.id, { status: "running" });

  // Use port-based routing to determine the correct successors.
  // findReadyNodes without activeEdges would return ALL structural successors
  // (e.g. both "success" and "generate-question"), ignoring the port selection.
  // Instead, compute the port-specific successors and let walkGraph handle
  // convergence checks via its internal activeEdges reconstruction.
  const successors = getSuccessors(workflow.definition, step.nodeId, nextPort);

  if (successors.length > 0) {
    await walkGraph(workflow.definition, run.id, ctx, successors, registry, workflow.id);
  } else {
    finalizeOrWait(run.id);
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
  const result = resolveWaitState(waitId, { status, firedPayload: cappedPayload });
  if (!result.updated || !result.row) return;

  const waitRow = result.row;

  // 2. Load the surrounding run + step. If anything has moved on (cancelled,
  // failed, retried, etc.), stay quiet.
  const run = getWorkflowRun(waitRow.workflowRunId);
  if (!run || (run.status !== "waiting" && run.status !== "running")) return;

  const step = getWorkflowRunStep(waitRow.workflowRunStepId);
  if (!step || step.status !== "waiting") return;

  const workflow = getWorkflow(run.workflowId);
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

  checkpointStep(run.id, step.id, step.nodeId, { output: stepOutput, nextPort }, ctx);
  updateWorkflowRun(run.id, { status: "running" });

  // 5. Bus listener bookkeeping: this wait is no longer pending, so drop it
  // from the per-event subscription set. If the set empties out, unwire the
  // bus listener.
  if (waitRow.mode === "event" && waitRow.eventName) {
    pruneWaitFromBus(waitRow.id, waitRow.eventName);
  }

  const successors = getSuccessors(workflow.definition, step.nodeId, nextPort);
  if (successors.length > 0) {
    await walkGraph(workflow.definition, run.id, ctx, successors, registry, workflow.id);
  } else {
    finalizeOrWait(run.id);
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
export function initWaitBusSubscriptions(registry: ExecutorRegistry): void {
  busRegistry = registry;
  // Pre-existing listeners are fine — they pick up the new registry via the
  // module-level `busRegistry` reference.
  // Recover pending event-mode waits from DB so signals fired pre-recovery
  // arrive at the right wait once the listener is registered.
  // We use a dedicated DB query rather than getPendingWaitsByEvent so we can
  // page through ALL distinct event names in one pass.
  const pendingNames = collectPendingEventNames();
  for (const name of pendingNames) {
    const pending = getPendingWaitsByEvent(name);
    for (const w of pending) {
      registerWait(w.id, name);
    }
  }
}

function collectPendingEventNames(): Set<string> {
  return new Set(getPendingEventWaitNames());
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
      // Fire-and-forget: don't block the bus thread. Errors are logged
      // per-wait inside processBusEvent.
      void processBusEvent(eventName, data);
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
      const row = getWaitStateById(waitId);
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
