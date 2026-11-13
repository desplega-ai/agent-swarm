import { isAlias } from "@desplega/model-catalog";
import {
  type Agent,
  type ModelProfile,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
  type SwarmConfig,
} from "../api/types";

/** The model and effort an agent's next task starts with, as its saved config says. */
export interface SavedRuntime {
  model?: string;
  effort?: ReasoningEffortLevel;
}

const KEYS = ["MODEL_OVERRIDE", "REASONING_EFFORT_OVERRIDE", "MODEL_PROFILE"];

/**
 * The saved model and effort per agent, from the agent-scope config rows. Same
 * precedence as claim-time resolution (`src/be/model-tier-resolution.ts`): the
 * agent's default profile (`MODEL_PROFILE`) wins over `MODEL_OVERRIDE` when it
 * applies, meaning the profile exists on the agent's harness. The profile's
 * effort fills in only when it has one. Every list that shows an agent's saved
 * model reads it here, so none can disagree with what claim runs.
 */
export function savedRuntimeByAgent(
  configs: readonly SwarmConfig[] | undefined,
  agents: readonly Pick<Agent, "id" | "harnessProvider" | "provider">[],
  profiles: readonly ModelProfile[] | undefined,
): Map<string, SavedRuntime> {
  const rowsByAgent = new Map<string, Record<string, string>>();
  for (const row of configs ?? []) {
    const value = row.value.trim();
    if (row.scope !== "agent" || !row.scopeId || !value || !KEYS.includes(row.key)) continue;
    rowsByAgent.set(row.scopeId, { ...rowsByAgent.get(row.scopeId), [row.key]: value });
  }

  const saved = new Map<string, SavedRuntime>();
  for (const agent of agents) {
    const rows = rowsByAgent.get(agent.id);
    if (!rows) continue;
    const override = rows.REASONING_EFFORT_OVERRIDE;
    let effort = (REASONING_EFFORT_LEVELS as readonly string[]).includes(override)
      ? (override as ReasoningEffortLevel)
      : undefined;
    let model: string | undefined = rows.MODEL_OVERRIDE;
    if (rows.MODEL_PROFILE) {
      // Profiles still loading: show nothing rather than an override that may lose.
      if (!profiles) {
        saved.set(agent.id, {});
        continue;
      }
      const harness = agent.harnessProvider ?? agent.provider;
      const profile = profiles.find((p) => p.name === rows.MODEL_PROFILE && p.harness === harness);
      if (profile) {
        // shortcut: a `latest:` alias resolves at claim and the UI has no resolver here; show
        // the last-used model instead, upgrade when the profiles list carries the resolved model.
        model = isAlias(profile.model) ? undefined : profile.model;
        effort = profile.effort ?? effort;
      }
    }
    saved.set(agent.id, { model, effort });
  }
  return saved;
}
