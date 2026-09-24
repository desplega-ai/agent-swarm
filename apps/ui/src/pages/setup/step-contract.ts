import type { OnboardingAction, OnboardingResponse } from "@/api/types";

/** Options of a Continue blocker. */
export interface ContinueBlockerOptions {
  /** Work is in flight (a save, a probe, a check): the footer shows a spinner. */
  busy?: boolean;
}

/** Options of a Continue action. */
export interface ContinueActionOptions {
  /**
   * `true`: the action finishes a step that is not done yet, so the shell
   * enables Continue while the action is set (step 2 stores the suggested
   * name). `false` (default): the action only runs before the shell moves
   * on when Continue is already enabled (step 3 applies default models).
   */
  unlocks?: boolean;
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
   * Run `action` when the operator presses Continue, before the shell moves
   * on. The footer shows its spinner while the action runs. When the action
   * throws, the shell stays and shows the error. With `unlocks: true`, the
   * action can also finish a step that is not done yet (for example: store
   * the suggested default, then complete the step), so Continue is enabled
   * while it is set. Skip never runs the action. Pass `null` to remove it.
   * The shell clears it on step change.
   */
  setContinueAction: (
    action: (() => Promise<void>) | null,
    options?: ContinueActionOptions,
  ) => void;
}
