import type { OnboardingAction, OnboardingResponse } from "@/api/types";

/**
 * Props every `/setup` step component receives from the shell (`page.tsx`).
 * Steps 2-6 always get a payload. Step 1 (connect) has its own props because
 * it renders before a connection exists.
 */
export interface StepProps {
  /** Latest `GET /api/onboarding` payload (polled by the shell). */
  onboarding: OnboardingResponse;
  /** Apply a transition. Resolves with the fresh payload (the cache is updated too). */
  act: (action: OnboardingAction) => Promise<OnboardingResponse>;
  /** Move to the next step. The shell owns the URL and the `view` transition. */
  goNext: () => void;
  /**
   * Hold the shell's Continue with a short reason shown as its tooltip (for
   * example "Saving…" while an autosave is in flight, or "Pick who you are"
   * in step 1). Pass `null` to release it. The shell clears it on step change.
   */
  setContinueBlocker: (reason: string | null) => void;
}
