import { type UseQueryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type {
  OnboardingAction,
  OnboardingMemoryTestRequest,
  OnboardingResponse,
  OnboardingState,
  OnboardingStepId,
} from "../types";
import {
  ONBOARDING_STEPS,
  type OnboardingStepDef,
  visibleOnboardingSteps,
} from "./visible-onboarding-steps";

export { ONBOARDING_STEPS, type OnboardingStepDef, visibleOnboardingSteps };

/**
 * First-run onboarding (`GET/PUT /api/onboarding`). The query resolves to
 * `null` against an API without the route: callers treat that as "feature
 * absent" and keep today's behavior.
 */
export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;

type OnboardingQueryOptions = Pick<
  UseQueryOptions<
    OnboardingResponse | null,
    Error,
    OnboardingResponse | null,
    typeof ONBOARDING_QUERY_KEY
  >,
  "enabled" | "refetchInterval"
>;

/**
 * A payload without some step (an API from before the step existed, or a
 * cache persisted before it did) reads that step as `todo`.
 */
function withAllSteps(data: OnboardingResponse | null): OnboardingResponse | null {
  if (!data || ONBOARDING_STEPS.every(({ id }) => data.state.steps[id])) return data;
  const todo = { status: "todo", at: null, method: null, errorClass: null } as const;
  const steps = Object.fromEntries(
    ONBOARDING_STEPS.map(({ id }) => [id, data.state.steps[id] ?? todo]),
  ) as OnboardingState["steps"];
  return { ...data, state: { ...data.state, steps } };
}

/**
 * No poll by default. `/setup` and the shell's `OnboardingRedirect` poll; every
 * other reader shares their cache.
 */
export function useOnboarding(options?: OnboardingQueryOptions) {
  return useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => api.fetchOnboarding(),
    select: withAllSteps,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? 0,
    retry: 1,
  });
}

function selectVisibleSteps(data: OnboardingResponse | null): ReadonlyArray<OnboardingStepDef> {
  return visibleOnboardingSteps(data?.state, data?.signals);
}

/**
 * The steps this API shows, in order. Reads the raw payload (before
 * `withAllSteps` back-fills), so a step the API does not know stays hidden.
 * Shares the `useOnboarding` cache; never polls on its own.
 */
export function useVisibleOnboardingSteps(options?: {
  enabled?: boolean;
}): ReadonlyArray<OnboardingStepDef> {
  const { data } = useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => api.fetchOnboarding(),
    select: selectVisibleSteps,
    enabled: options?.enabled ?? true,
    retry: 1,
  });
  return data ?? visibleOnboardingSteps(null, null);
}

/**
 * True while first-run onboarding owns a prompt the shell would otherwise show
 * (identity, organization name): until the onboarding query answers, and while
 * onboarding is open. With `whileMinimized: false` a minimized setup releases
 * the prompt, because only an open, unminimized setup sends the operator to `/setup`.
 */
export function useOnboardingOwnsFirstRun(options?: { whileMinimized?: boolean }): boolean {
  const { data, isPending } = useOnboarding();
  if (isPending) return true;
  if (!data || !isOnboardingOpen(data)) return false;
  return (options?.whileMinimized ?? true) || !data.state.minimizedAt;
}

/** Apply a transition; the response is the fresh payload, so it replaces the cache. */
export function useOnboardingAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: OnboardingAction) => api.updateOnboarding(action),
    // A GET that started before the PUT must not overwrite the PUT response.
    onMutate: () => queryClient.cancelQueries({ queryKey: ONBOARDING_QUERY_KEY }),
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

/** Done steps among `steps`: the one progress count of the header pill and the home card. */
export function onboardingDoneCount(
  state: OnboardingState,
  steps: ReadonlyArray<OnboardingStepDef>,
): number {
  return steps.filter(({ id }) => state.steps[id].status === "done").length;
}

/** Where Resume lands: the current step, unless it is already settled or hidden. */
export function onboardingResumeStep(
  state: OnboardingState,
  steps: ReadonlyArray<OnboardingStepDef>,
): OnboardingStepId {
  const shown = steps.some(({ id }) => id === state.currentStep);
  const current = state.steps[state.currentStep].status;
  if (shown && current !== "done" && current !== "skipped") return state.currentStep;
  const next = steps.find(({ id }) => {
    const status = state.steps[id].status;
    return status === "todo" || status === "failed";
  });
  return next?.id ?? state.currentStep;
}
