import {
  getCompletedStepNodeIds,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { checkpointStep } from "./checkpoint";
import { findReadyNodes, walkGraph } from "./engine";
import type { WorkflowEventBus } from "./event-bus";
import type { ExecutorRegistry } from "./executors/registry";

interface TaskEvent {
  taskId: string;
  output?: string;
  agentId?: string;
  workflowRunId?: string;
  workflowRunStepId?: string;
  failureReason?: string;
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

  // Use convergence-aware node detection instead of blindly passing successors.
  // This prevents duplicate step creation for convergence nodes (e.g., fan-out → merge).
  // findReadyNodes checks ALL predecessors are completed before marking a node ready.
  const completedNodeIds = new Set(getCompletedStepNodeIds(run.id));
  const readyNodes = findReadyNodes(workflow.definition, completedNodeIds);

  if (readyNodes.length > 0) {
    await walkGraph(workflow.definition, run.id, ctx, readyNodes, registry, workflow.id);
  } else {
    finalizeOrWait(run.id);
  }
}

/**
 * If no nodes are ready and no steps are still waiting, finalize the run.
 * Otherwise set it back to waiting for the next task completion.
 */
function finalizeOrWait(runId: string): void {
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
  const completedNodeIds = new Set(getCompletedStepNodeIds(run.id));
  const readyNodes = findReadyNodes(workflow.definition, completedNodeIds);

  if (readyNodes.length > 0) {
    await walkGraph(workflow.definition, run.id, ctx, readyNodes, registry, workflow.id);
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
