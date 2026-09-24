import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type {
  OnboardingAction,
  OnboardingMemoryTestRequest,
  OnboardingResponse,
  OnboardingState,
  OnboardingStepId,
} from "../types";

/**
 * First-run onboarding (`GET/PUT /api/onboarding`). The query resolves to
 * `null` against an API without the route: callers treat that as "feature
 * absent" and keep today's behavior.
 */
export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;

export const ONBOARDING_STEPS: ReadonlyArray<{ id: OnboardingStepId; label: string }> = [
  { id: "connect", label: "Connect" },
  { id: "name", label: "Name your swarm" },
  { id: "ai", label: "AI provider" },
  { id: "memory", label: "Memory" },
  { id: "integrations", label: "Integrations" },
  { id: "first_task", label: "First task" },
];

export function useOnboarding(options?: { enabled?: boolean; pollIntervalMs?: number }) {
  return useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => api.fetchOnboarding(),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.pollIntervalMs ?? 10_000,
    retry: 1,
  });
}

/** Apply a transition; the response is the fresh payload, so it replaces the cache. */
export function useOnboardingAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: OnboardingAction) => api.updateOnboarding(action),
    onSuccess: (data) => {
      queryClient.setQueryData<OnboardingResponse | null>(ONBOARDING_QUERY_KEY, data);
    },
  });
}

/** Test (and on success save) an embeddings endpoint. */
export function useTestOnboardingMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OnboardingMemoryTestRequest) => api.testOnboardingMemory(body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
  });
}

/** Finished = the first task completed, or the install predates onboarding (R1). */
export function isOnboardingFinished(state: OnboardingState): boolean {
  return Boolean(state.completedAt || state.autoCompleted);
}

/** The pill and home card show while onboarding is neither finished nor dismissed. */
export function isOnboardingOpen(data: OnboardingResponse | null | undefined): boolean {
  if (!data) return false;
  return !isOnboardingFinished(data.state) && !data.state.dismissedAt;
}

/** Steps settled by the operator: done or skipped. */
export function onboardingSettledCount(state: OnboardingState): number {
  return ONBOARDING_STEPS.filter(({ id }) => {
    const status = state.steps[id].status;
    return status === "done" || status === "skipped";
  }).length;
}

/** Where Resume lands: the current step, unless it is already settled. */
export function onboardingResumeStep(state: OnboardingState): OnboardingStepId {
  const current = state.steps[state.currentStep].status;
  if (current !== "done" && current !== "skipped") return state.currentStep;
  const next = ONBOARDING_STEPS.find(({ id }) => {
    const status = state.steps[id].status;
    return status === "todo" || status === "failed";
  });
  return next?.id ?? state.currentStep;
}
