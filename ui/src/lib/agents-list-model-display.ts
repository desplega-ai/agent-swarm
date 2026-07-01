import type { ReasoningEffortLevel } from "@/api/types";
import { findKnownModel, type ProviderIconKey } from "./agent-runtime-models";

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

/** Ordinal position of each level — used to size the `[|||]`-style badge (more bars = more effort). */
const REASONING_EFFORT_BADGE_INDEX: Record<ReasoningEffortLevel, number> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
};

/**
 * Compact ASCII badge for the agents-list Model column, e.g. `[|||]` for
 * `high`. Bracketed pipes (not a bare repeated `.`) so it doesn't read as a
 * data-grid truncation ellipsis. `undefined`/`"off"` render no badge — only
 * a non-off configured level is visually distinct enough to warrant one.
 */
export function reasoningEffortBadge(level: ReasoningEffortLevel | undefined): string | null {
  if (!level) return null;
  const index = REASONING_EFFORT_BADGE_INDEX[level];
  return index > 0 ? `[${"|".repeat(index)}]` : null;
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
