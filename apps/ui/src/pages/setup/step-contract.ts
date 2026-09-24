import type { OnboardingAction, OnboardingResponse } from "@/api/types";

/**
 * Props every `/setup` step component receives from the shell (`page.tsx`).
 * Steps 2-6 always get a payload. Step 1 (connect) renders before a
 * connection exists, so it receives `onboarding: null` there.
 */
export interface StepProps {
  /** Latest `GET /api/onboarding` payload (polled by the shell). */
  onboarding: OnboardingResponse;
  /** Apply a transition. Resolves with the fresh payload (the cache is updated too). */
  act: (action: OnboardingAction) => Promise<OnboardingResponse>;
  /** Move to the next step. The shell owns the URL and the `view` transition. */
  goNext: () => void;
}
