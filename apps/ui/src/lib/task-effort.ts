import { isReasoningHarness, type ReasoningEffortLevel } from "@desplega/model-catalog";
import type { ModelTierPreview } from "@/api/types";
import { effortLevelsFor, HARNESS_LABEL, type LiveModelsCatalog } from "./agent-runtime-models";
import { tierRowModel } from "./model-tiers";

/**
 * What a new task can ask for as reasoning effort, from the agent it goes to and
 * the model it will run.
 *
 * The model, first hit wins: the Model Tier picked on the task (the tier's model
 * for the agent's harness), else the agent's stored `MODEL_OVERRIDE`, else the
 * model the agent last ran. The first two are configuration, so their levels are
 * exact (`effortLevelsFor`, the rule the API applies). The last is only a report,
 * so a model the catalog cannot resolve counts as unknown, not as "no effort".
 */
export type TaskEffortOptions =
  | {
      kind: "levels";
      levels: readonly ReasoningEffortLevel[];
      /** No model is known: `levels` is the subset every effort harness accepts. */
      guessed: boolean;
    }
  | {
      kind: "unsupported";
      /** Why the picker is off. */
      reason: string;
    };

/** Accepted by all four effort harnesses on at least their default models. */
export const SHARED_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = ["low", "medium", "high"];

export interface TaskEffortInput {
  /** The agent's harness; unknown until its worker reports. */
  harness: string | null | undefined;
  /** The Model Tier picked on the task, or `""`. */
  tier: string;
  tiers: readonly ModelTierPreview[] | null | undefined;
  /** The agent's stored `MODEL_OVERRIDE`. */
  agentModel: string | null | undefined;
  /** The model the agent last ran (`credStatus.latestModel.model`). */
  lastUsedModel: string | null | undefined;
  catalog: LiveModelsCatalog | null | undefined;
}

export function taskEffortOptions(input: TaskEffortInput): TaskEffortOptions {
  const { harness, tier, tiers, agentModel, lastUsedModel, catalog } = input;
  if (harness && !isReasoningHarness(harness)) {
    return {
      kind: "unsupported",
      reason: `${HARNESS_LABEL[harness] ?? harness} has no reasoning effort control.`,
    };
  }
  const guess: TaskEffortOptions = { kind: "levels", levels: SHARED_EFFORT_LEVELS, guessed: true };
  if (!harness) return guess;

  const configured = tier ? tierRowModel(tiers, harness, tier) : agentModel?.trim() || null;
  if (configured) {
    const levels = effortLevelsFor(harness, configured, catalog);
    return levels.length > 0
      ? { kind: "levels", levels, guessed: false }
      : { kind: "unsupported", reason: `${configured} takes no reasoning effort override.` };
  }

  const reported = tier ? null : lastUsedModel?.trim() || null;
  const levels = reported ? effortLevelsFor(harness, reported, catalog) : [];
  return levels.length > 0 ? { kind: "levels", levels, guessed: false } : guess;
}

/** The effort a task keeps: `effort` when the options offer it, else `""` (the agent default). */
export function effortAllowed(options: TaskEffortOptions, effort: string): string {
  return options.kind === "levels" && (options.levels as readonly string[]).includes(effort)
    ? effort
    : "";
}
