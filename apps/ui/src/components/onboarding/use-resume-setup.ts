import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useOnboardingAction } from "@/api/hooks/use-onboarding";
import type { OnboardingStepId } from "@/api/types";
import { setupStepHref } from "./step-status";

/**
 * Resume setup from the pill or the home card: clear `minimizedAt` /
 * `dismissedAt`, then open `/setup` on the given step. A failed write still
 * navigates, because `/setup` retries the resume on mount.
 */
export function useResumeSetup() {
  const navigate = useNavigate();
  const action = useOnboardingAction();

  async function resume(step: OnboardingStepId) {
    try {
      await action.mutateAsync({ action: "resume" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resume setup");
    }
    void navigate(setupStepHref(step));
  }

  return { resume, isPending: action.isPending };
}
