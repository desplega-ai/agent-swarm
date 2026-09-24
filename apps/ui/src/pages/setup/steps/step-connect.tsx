import type { OnboardingResponse } from "@/api/types";

export interface StepConnectProps {
  /** Null until a connection exists (the shell renders step 1 before any API call works). */
  onboarding: OnboardingResponse | null;
  /** Called after `/health` passes and the connection is stored and active. */
  onConnected: () => void;
}

// Placeholder: replaced by the owning implementation phase.
export function StepConnect(_props: StepConnectProps) {
  return <div className="text-sm text-muted-foreground">Coming soon.</div>;
}
