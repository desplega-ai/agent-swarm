import type { OnboardingAction, OnboardingResponse } from "@/api/types";

/** Options of a Continue blocker. */
export interface ContinueBlockerOptions {
  /** Work is in flight (a save, a probe, a check): the footer shows a spinner. */
  busy?: boolean;
}

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
  /**
   * Hold the shell's Continue with a short reason shown as its tooltip (for
   * example "Saving…" while an autosave is in flight, or "Pick who you are"
   * in step 1). Pass `busy` for work in flight, so the footer shows a
   * spinner. Pass `null` to release it. The shell clears it on step change.
   */
  setContinueBlocker: (reason: string | null, options?: ContinueBlockerOptions) => void;
  /**
   * Let Continue finish a step that is not done yet (for example: store the
   * suggested default, then complete the step). While an action is set, the
   * shell enables Continue, runs the action with the footer spinner, then
   * moves on. When the action throws, the shell stays and shows the error.
   * Pass `null` to remove it. The shell clears it on step change.
   */
  setContinueAction: (action: (() => Promise<void>) | null) => void;
}
