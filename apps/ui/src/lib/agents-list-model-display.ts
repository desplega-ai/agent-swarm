import type { ReasoningEffortLevel } from "@/api/types";
import {
  findKnownModel,
  humanizeModelId,
  type LiveModelsCatalog,
  type ProviderIconKey,
} from "./agent-runtime-models";

export interface AgentModelDisplay {
  configured: string | null;
  lastUsed: string | null;
  primary: string | null;
  diverged: boolean;
  /** Last-reported reasoning/effort level (`cred_status.latestModel.reasoningEffort`). Absent when unset (harness-native default). */
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

  const known = findKnownModel(raw, liveCatalog);
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

  return {
    configured,
    lastUsed,
    primary: configured,
    reasoningEffort,
    diverged: true,
  };
}
