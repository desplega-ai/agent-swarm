import { createTaskExtended } from "../../be/db";
import type { NodeResult } from "../engine";
import { interpolate } from "../template";

export interface CreateTaskConfig {
  template: string;
  agentId?: string;
  tags?: string[];
  source?: string;
  priority?: number;
}

export function executeCreateTask(
  config: CreateTaskConfig,
  ctx: Record<string, unknown>,
  runId: string,
  stepId: string,
): NodeResult {
  const taskDescription = interpolate(config.template, ctx);
  const tags = (config.tags ?? []).map((t) => interpolate(t, ctx));
  const task = createTaskExtended(taskDescription, {
    agentId: config.agentId ?? null,
    source: "workflow",
    tags,
    priority: config.priority,
    workflowRunId: runId,
    workflowRunStepId: stepId,
  });
  return {
    mode: "async",
    nextPort: "default",
    output: { taskId: task.id, taskStatus: task.status },
  };
}
