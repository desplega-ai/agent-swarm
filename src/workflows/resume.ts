import {
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { getSuccessors, walkDag } from "./engine";
import type { WorkflowEventBus } from "./event-bus";

interface TaskEvent {
  taskId: string;
  output?: string;
  agentId?: string;
  workflowRunId?: string;
  workflowRunStepId?: string;
  failureReason?: string;
}

export function setupWorkflowResumeListener(eventBus: WorkflowEventBus): void {
  eventBus.on("task.completed", async (data: unknown) => {
    const event = data as TaskEvent;
    if (!event.workflowRunId || !event.workflowRunStepId) return;
    await resumeFromTaskCompletion(event);
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

async function resumeFromTaskCompletion(event: TaskEvent): Promise<void> {
  const run = getWorkflowRun(event.workflowRunId!);
  if (!run || run.status !== "waiting") return;

  const step = getWorkflowRunStep(event.workflowRunStepId!);
  if (!step || step.status !== "waiting") return;

  const workflow = getWorkflow(run.workflowId);
  if (!workflow) return;

  // Mark step completed
  updateWorkflowRunStep(step.id, {
    status: "completed",
    output: { taskOutput: event.output },
    finishedAt: new Date().toISOString(),
  });

  // Resume context
  const ctx = (run.context ?? {}) as Record<string, unknown>;
  ctx[step.nodeId] = { taskOutput: event.output };
  updateWorkflowRun(run.id, { status: "running", context: ctx });

  // Continue DAG walk from successors
  const successors = getSuccessors(workflow.definition, step.nodeId, "default");
  await walkDag(workflow.definition, run.id, ctx, successors);
}

function markRunFailed(event: TaskEvent, reason: string): void {
  updateWorkflowRunStep(event.workflowRunStepId!, {
    status: "failed",
    error: reason,
    finishedAt: new Date().toISOString(),
  });
  updateWorkflowRun(event.workflowRunId!, {
    status: "failed",
    error: reason,
    finishedAt: new Date().toISOString(),
  });
}

export async function retryFailedRun(runId: string): Promise<void> {
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
  await walkDag(workflow.definition, runId, ctx, [node]);
}
