// The `/setup` step list and which steps this API shows. No `@/` imports: root
// tests load this module directly.

import type { OnboardingSignals, OnboardingStepId } from "../types";

export interface OnboardingStepDef {
  id: OnboardingStepId;
  label: string;
}

export const ONBOARDING_STEPS: ReadonlyArray<OnboardingStepDef> = [
  { id: "connect", label: "Connect" },
  { id: "name", label: "Identity" },
  { id: "ai", label: "AI Providers" },
  { id: "agents", label: "Agents" },
  { id: "memory", label: "Memory" },
  { id: "integrations", label: "Integrations" },
  { id: "files", label: "Files" },
  { id: "first_task", label: "First task" },
];

/** Steps that show only when the API knows them. The others always show. */
const OPTIONAL_STEPS: ReadonlySet<OnboardingStepId> = new Set(["files"]);

// One array per distinct list, so callers can use the result as a memo dependency.
const cache = new Map<string, ReadonlyArray<OnboardingStepDef>>();

/**
 * The steps to show, in order. `rawState` is the server payload before the
 * client back-fills missing steps as `todo`: an API from before a step does
 * not list it, so the step stays hidden there. `files` also needs Comb on
 * (`signals.files.enabled`). With no payload yet, optional steps stay hidden.
 */
export function visibleOnboardingSteps(
  rawState: { steps?: Partial<Record<string, unknown>> } | null | undefined,
  signals: Pick<OnboardingSignals, "files"> | null | undefined,
): ReadonlyArray<OnboardingStepDef> {
  const steps = rawState?.steps;
  const visible = ONBOARDING_STEPS.filter(({ id }) => {
    if (!OPTIONAL_STEPS.has(id)) return true;
    if (!steps || !(id in steps)) return false;
    if (id === "files") return signals?.files?.enabled === true;
    return true;
  });
  const key = visible.map(({ id }) => id).join(",");
  const cached = cache.get(key);
  if (cached) return cached;
  cache.set(key, visible);
  return visible;
}
