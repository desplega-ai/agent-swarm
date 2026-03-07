import { createTaskExtended } from "../../be/db";
import type { NodeResult } from "../engine";
import { interpolate } from "../template";

export interface DelegateToAgentConfig {
  agentId: string;
  taskTemplate: string;
  tags?: string[];
  offerMode?: boolean;
}

export function executeDelegateToAgent(
  config: DelegateToAgentConfig,
  ctx: Record<string, unknown>,
  runId: string,
  stepId: string,
): NodeResult {
  const taskDescription = interpolate(config.taskTemplate, ctx);
  const tags = (config.tags ?? []).map((t) => interpolate(t, ctx));
  const task = createTaskExtended(taskDescription, {
    agentId: config.offerMode ? null : config.agentId,
    offeredTo: config.offerMode ? config.agentId : undefined,
    source: "workflow",
    tags,
    workflowRunId: runId,
    workflowRunStepId: stepId,
  });
  return {
    mode: "async",
    nextPort: "default",
    output: { taskId: task.id, taskStatus: task.status, agentId: config.agentId },
  };
}
