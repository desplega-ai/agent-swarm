import type { AgentTask } from "../types";

/** Missing fields read as unset, so a bare `{ model }` is its own pin. */
export type TaskModelPinFields = {
  [K in
    | "model"
    | "modelSource"
    | "modelAlias"
    | "modelTier"
    | "resolvedModel"
    | "claudeSessionId"]?: AgentTask[K] | null;
};

/**
 * The task's own `model` pin, or undefined when the task has none.
 *
 * `agent_tasks.model` is not always the creator's pin: the worker reports the
 * model it actually ran on `PUT /api/tasks/{id}/session`, which overwrites the
 * column. So the pin is read from the claim-time record instead:
 *   - `modelSource = "model"`: the task's own `model` won at claim. A `latest:`
 *     alias survives only in `modelAlias` (the session report replaced `model`
 *     with the concrete id), so the alias is the pin.
 *   - `modelSource = "fallback:cli-unsupported:model"`: the task's own
 *     `latest:` alias won, then the claiming CLI rejected what it resolved to.
 *     The alias in `modelAlias` is the pin, with or without a `modelTier`.
 *   - `modelSource = "fallback:cli-unsupported"` (a tier layer's alias fell
 *     back) is not a pin. Rows written before the `:model` variant existed are
 *     ambiguous; one with a `modelAlias` and no `modelTier` can only have come
 *     from a `model` alias, so its alias is the pin. With a `modelTier` it stays
 *     ambiguous and only the tier counts.
 *   - no claim record and no session: `model` is still the creator's value.
 * Anything else (a tier layer won, or `model` is just the session report) is
 * not a pin: re-running the row must resolve the model again, from the agent's
 * current config, instead of replaying the model of the previous run.
 */
export function taskModelPin(task: TaskModelPinFields): string | undefined {
  if (task.modelSource === "model") return task.modelAlias ?? task.model ?? undefined;
  if (task.modelSource === "fallback:cli-unsupported:model" && task.modelAlias) {
    return task.modelAlias;
  }
  if (task.modelSource === "fallback:cli-unsupported" && task.modelAlias && !task.modelTier) {
    return task.modelAlias;
  }
  if (!task.modelSource && !task.resolvedModel && !task.claudeSessionId) {
    return task.model ?? undefined;
  }
  return undefined;
}

/**
 * The model fields a re-run of the SAME task row (paused-task resume) passes to
 * the spawn: the pin and the claim record that resolved it, or nothing, so the
 * worker resolves the model from the agent's current config.
 */
export function resumedTaskModelSelection(task: TaskModelPinFields): {
  model: string | undefined;
  resolvedModel: string | undefined;
  modelSource: string | undefined;
} {
  const pin = taskModelPin(task);
  if (!pin) return { model: undefined, resolvedModel: undefined, modelSource: undefined };
  return {
    model: pin,
    resolvedModel: task.resolvedModel ?? undefined,
    modelSource: task.modelSource ?? undefined,
  };
}
