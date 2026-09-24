import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  isOnboardingOpen,
  ONBOARDING_STEPS,
  onboardingResumeStep,
  onboardingSettledCount,
  useOnboarding,
  useOnboardingAction,
} from "@/api/hooks/use-onboarding";
import type { OnboardingResponse, OnboardingStepId, OnboardingStepStatus } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useConfig } from "@/hooks/use-config";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
import { INTEGRATIONS } from "@/lib/integrations-catalog";
import { cn } from "@/lib/utils";
import { SetupCard } from "./setup-card";
import { SKIPPED_HATCH, STEP_TONE_CLASS, StepStatusChip, stepNumber } from "./step-status";
import { useResumeSetup } from "./use-resume-setup";

/** Home dashboard card while onboarding is open. Wrapper `id="setup"` is the `/#setup` anchor. */
export function SetupChecklistCard() {
  const { data } = useOnboarding();
  const { data: status } = useStatusContext();
  const { config } = useConfig();
  const { resume, isPending: resuming } = useResumeSetup();
  const dismiss = useOnboardingAction();

  if (!data || !isOnboardingOpen(data)) return null;
  const { state } = data;
  const settled = onboardingSettledCount(state);
  const resumeStep = onboardingResumeStep(state);
  const busy = resuming || dismiss.isPending;
  const context = { apiUrl: config.apiUrl, swarmName: status?.identity.name ?? "your swarm" };

  async function handleDismiss() {
    try {
      await dismiss.mutateAsync({ action: "dismiss" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not dismiss setup");
    }
  }

  return (
    <div id="setup" className="w-full max-w-3xl flex-none scroll-mt-4">
      <SetupCard title="Finish setting up your swarm" bodyClassName="p-0">
        <div className="px-4 pt-3 pb-1">
          <Progress
            value={(settled / ONBOARDING_STEPS.length) * 100}
            aria-label={`${settled} of ${ONBOARDING_STEPS.length} steps settled`}
            className="h-1 bg-muted"
          />
        </div>
        <ul className="divide-y divide-border-subtle">
          {ONBOARDING_STEPS.map(({ id, label }) => {
            const stepStatus = state.steps[id].status;
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resume(id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                >
                  <StepTile id={id} status={stepStatus} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm font-medium",
                        stepStatus === "done" && "text-muted-foreground",
                      )}
                    >
                      {label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {stepSubtitle(id, data, context)}
                    </span>
                  </span>
                  <StepStatusChip status={stepStatus} />
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle bg-surface px-4 py-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Progress is kept per step. Resume opens step {stepNumber(resumeStep)}.
          </p>
          <Button variant="ghost" disabled={busy} onClick={() => void handleDismiss()}>
            Dismiss
          </Button>
          <Button disabled={busy} onClick={() => void resume(resumeStep)}>
            Resume
            <ArrowRight />
          </Button>
        </div>
      </SetupCard>
    </div>
  );
}

/** One-line row subtitle, read from the live signals. */
function stepSubtitle(
  id: OnboardingStepId,
  { state, signals }: OnboardingResponse,
  context: { apiUrl: string; swarmName: string },
): string {
  const stepStatus = state.steps[id].status;
  switch (id) {
    case "connect":
      return `${context.apiUrl} answered /health`;
    case "name":
      if (stepStatus === "done") return `Called ${context.swarmName}`;
      return stepStatus === "skipped" ? "Skipped" : "Not named yet";
    case "ai": {
      const verified = signals.providers.find((p) => p.state === "verified");
      if (verified) return `${HARNESS_LABEL[verified.provider] ?? verified.provider} verified`;
      if (signals.providers.some((p) => p.state === "configured")) return "Waiting for a worker";
      return "Not set up";
    }
    case "memory":
      if (signals.embeddings.configured) return `${signals.embeddings.dimensions} dims`;
      return stepStatus === "skipped" ? "Skipped" : "Off";
    case "integrations": {
      const connected = Object.entries(signals.integrations)
        .filter(([, on]) => on)
        .map(([id]) => INTEGRATIONS.find((def) => def.id === id)?.name ?? id);
      return connected.length > 0 ? connected.join(", ") : "Nothing connected";
    }
    case "first_task":
      if (stepStatus === "done" || signals.firstTask?.status === "completed") return "Completed";
      if (signals.firstTask) return "Sent";
      return signals.agents.leadsOnline > 0 ? "Ready" : "Lead not ready yet";
  }
}

/** Check tile for a verified step, the step number otherwise (same tones as the `/setup` stepper). */
function StepTile({ id, status }: { id: OnboardingStepId; status: OnboardingStepStatus }) {
  return (
    <span
      aria-hidden="true"
      style={status === "skipped" ? SKIPPED_HATCH : undefined}
      className={cn(
        "grid size-[22px] shrink-0 place-items-center rounded-md border bg-card font-mono text-[11px]",
        STEP_TONE_CLASS[status],
      )}
    >
      {status === "done" ? <Check className="size-3" strokeWidth={3} /> : stepNumber(id)}
    </span>
  );
}
