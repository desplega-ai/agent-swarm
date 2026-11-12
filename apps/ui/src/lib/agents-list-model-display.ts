import type { AgentLatestModel, ReasoningEffortLevel } from "@/api/types";
import {
  AMP_MODES,
  findKnownModel,
  humanizeModelId,
  type LiveModelsCatalog,
  type ProviderIconKey,
} from "./agent-runtime-models";

export interface AgentModelDisplay {
  configured: string | null;
  lastUsed: string | null;
  primary: string | null;
  /** The saved model differs from the last run and nothing explains it: shown as "next task". */
  diverged: boolean;
  /** The last run's model came from the task (a pin, a tier or a profile), not from this agent's settings. */
  lastUsedFromTask?: boolean;
  /** Effort the next task runs at: the saved REASONING_EFFORT_OVERRIDE, else the last-reported level. Absent when unset (harness default). */
  reasoningEffort?: ReasoningEffortLevel;
}

export interface AgentModelPresentation {
  raw: string;
  label: string;
  provider: string | null;
  providerId: ProviderIconKey | null;
}

function cleanModel(value: string | null | undefined): string | null {
  const model = value?.trim();
  return model ? model : null;
}

export function getAgentModelPresentation(
  value: string | null | undefined,
  liveCatalog?: LiveModelsCatalog,
): AgentModelPresentation | null {
  const raw = cleanModel(value);
  if (!raw) return null;

  // An Amp mode is not a catalog model, but it should still read as Amp.
  const ampMode = AMP_MODES.find((mode) => mode.id === raw.toLowerCase());
  const known =
    findKnownModel(raw, liveCatalog) ??
    (ampMode ? { label: ampMode.label, provider: "Amp modes", providerId: "amp" as const } : null);
  return {
    raw,
    label: known?.label ?? formatUnknownModelLabel(raw),
    provider: known?.provider ?? null,
    providerId: known?.providerId ?? null,
  };
}

function formatUnknownModelLabel(model: string): string {
  const segments = model.split("/");
  const id = segments.length > 1 ? segments[segments.length - 1] : model;
  return humanizeModelId(id);
}

export function getAgentModelDisplay(
  configuredModel: string | null | undefined,
  lastUsedModel: string | null | undefined,
  reasoningEffort?: ReasoningEffortLevel,
  lastUsedSource?: AgentLatestModel["source"],
): AgentModelDisplay {
  const configured = cleanModel(configuredModel);
  const lastUsed = cleanModel(lastUsedModel);

  if (!configured) {
    return {
      configured: null,
      lastUsed,
      primary: lastUsed,
      diverged: false,
      reasoningEffort,
    };
  }

  if (!lastUsed || configured === lastUsed) {
    return {
      configured,
      lastUsed,
      primary: configured,
      diverged: false,
      reasoningEffort,
    };
  }

  // A task that carries its own model, tier or profile beats the agent's saved model. The
  // saved model is not pending then: it still applies to the next task that carries none.
  if (lastUsedSource === "task") {
    return {
      configured,
      lastUsed,
      primary: configured,
      reasoningEffort,
      diverged: false,
      lastUsedFromTask: true,
    };
  }

  return {
    configured,
    lastUsed,
    primary: configured,
    reasoningEffort,
    diverged: true,
  };
}
