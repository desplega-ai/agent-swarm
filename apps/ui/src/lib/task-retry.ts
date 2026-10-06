import type { AgentTask } from "@/api/types";

/** The `POST /api/tasks` body that runs a task again. */
interface RetryTaskInput {
  task: string;
  agentId?: string;
  routingReason?: "continuity";
  parentTaskId: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  model?: string;
  modelTier?: string;
  effort?: string;
  requestedByUserId?: string;
  source: "ui";
}

/**
 * A copy of `task` as a new child task: the same prompt, agent, model and
 * settings, with `parentTaskId` = the original. The model is the one the task
 * asked for (`model`, `modelTier`), not `resolvedModel`, so the server
 * resolves it the same way again. The server copies the parent's Slack
 * thread, VCS, `dir` and `contextKey`.
 */
export function buildRetryInput(
  task: Pick<
    AgentTask,
    "id" | "task" | "agentId" | "taskType" | "tags" | "priority" | "model" | "modelTier" | "effort"
  >,
  userId: string | null | undefined,
): RetryTaskInput {
  const agentId = task.agentId ?? undefined;
  return {
    task: task.task,
    agentId,
    // `POST /api/tasks` requires a routing reason with an explicit agent.
    routingReason: agentId ? "continuity" : undefined,
    parentTaskId: task.id,
    taskType: task.taskType,
    tags: task.tags,
    priority: task.priority,
    model: task.model,
    modelTier: task.modelTier,
    effort: task.effort,
    requestedByUserId: userId ?? undefined,
    source: "ui",
  };
}
