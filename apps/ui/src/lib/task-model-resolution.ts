import type { AgentTask, ModelSource } from "@/api/types";
import { modelTierLabel } from "./model-tiers";

/** Labels for `agent_tasks.modelSource`, the layer that chose the model the task ran on. */
export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  model: "Task model",
  "worker-env": "Worker env override",
  "tier-config": "Tier config",
  "tier-default": "Tier default",
  "fallback:cli-unsupported": "Fallback (CLI rejected the requested model)",
};

export function modelSourceLabel(source: string): string {
  return MODEL_SOURCE_LABELS[source as ModelSource] ?? source;
}

type TaskModelFields = Pick<
  AgentTask,
  "model" | "modelTier" | "resolvedModel" | "modelSource" | "modelAlias"
>;

/**
 * The model a task ran (or will run) on: the server's claim-time resolution
 * when there is one, else what was requested. Null when the task named neither
 * a model nor a tier.
 */
export function taskDisplayModel(task: TaskModelFields): string | undefined {
  return task.resolvedModel ?? task.model ?? undefined;
}

/**
 * Tooltip lines explaining how the server picked the model, or [] when the
 * task has no claim-time resolution (unclaimed, or an older API).
 */
export function describeModelResolution(task: TaskModelFields): string[] {
  if (!task.resolvedModel) return [];
  const lines: string[] = [];
  const requested = task.model
    ? task.model
    : task.modelTier
      ? `tier ${modelTierLabel(task.modelTier)}`
      : null;
  if (requested && requested !== task.resolvedModel) lines.push(`Requested: ${requested}`);
  if (task.modelSource) lines.push(`Chosen by: ${modelSourceLabel(task.modelSource)}`);
  if (task.modelAlias) lines.push(`Alias: ${task.modelAlias}`);
  return lines;
}
