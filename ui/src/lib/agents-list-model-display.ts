import { findKnownModel, type ProviderIconKey } from "./agent-runtime-models";

export interface AgentModelDisplay {
  configured: string | null;
  lastUsed: string | null;
  primary: string | null;
  diverged: boolean;
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
): AgentModelPresentation | null {
  const raw = cleanModel(value);
  if (!raw) return null;

  const known = findKnownModel(raw);
  return {
    raw,
    label: known?.label ?? raw,
    provider: known?.provider ?? null,
    providerId: known?.providerId ?? null,
  };
}

export function getAgentModelDisplay(
  configuredModel: string | null | undefined,
  lastUsedModel: string | null | undefined,
): AgentModelDisplay {
  const configured = cleanModel(configuredModel);
  const lastUsed = cleanModel(lastUsedModel);

  if (!configured) {
    return {
      configured: null,
      lastUsed,
      primary: lastUsed,
      diverged: false,
    };
  }

  if (!lastUsed || configured === lastUsed) {
    return {
      configured,
      lastUsed,
      primary: configured,
      diverged: false,
    };
  }

  return {
    configured,
    lastUsed,
    primary: configured,
    diverged: true,
  };
}
