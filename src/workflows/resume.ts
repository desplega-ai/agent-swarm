import {
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import { walkGraph } from "./engine";
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
    markRunFailed(event, event.failureReason ?? "Task failed");
  });

  eventBus.on("task.cancelled", async (data: unknown) => {
    const event = data as TaskEvent;
    if (!event.workflowRunId || !event.workflowRunStepId) return;
    markRunFailed(event, "Task was cancelled");
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
  if (!run || run.status !== "waiting") return;

  const step = getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;

  const workflow = getWorkflow(run.workflowId);
  if (!workflow) return;

  // Checkpoint: atomic step completion + context update
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  const stepOutput = { taskId: event.taskId, taskOutput: event.output };

  checkpointStep(run.id, step.id, step.nodeId, { output: stepOutput }, ctx);

  // Set run back to running
  updateWorkflowRun(run.id, { status: "running" });

  // Find successors and continue DAG walk
  const successors = getSuccessors(workflow.definition, step.nodeId, "default");
  await walkGraph(workflow.definition, run.id, ctx, successors, registry, workflow.id);
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

  // Resume from the failed node
  const node = workflow.definition.nodes.find((n) => n.id === failedStep.nodeId);
  if (!node) throw new Error(`Node ${failedStep.nodeId} not found in workflow definition`);
  await walkGraph(workflow.definition, runId, ctx, [node], registry, workflow.id);
}
