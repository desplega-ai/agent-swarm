import { ArrowRight } from "lucide-react";
import { useState } from "react";
import {
  isOnboardingOpen,
  onboardingDoneCount,
  onboardingResumeStep,
  useOnboarding,
  useVisibleOnboardingSteps,
} from "@/api/hooks/use-onboarding";
import { SetupChip } from "@/components/shared/setup-chip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { STEP_STATUS_WORD, StepStatusGlyph, stepNumber } from "./step-status";
import { useResumeSetup } from "./use-resume-setup";

/** Header entry point while onboarding is open (minimized or not yet resumed). */
export function SetupPill() {
  const { data } = useOnboarding();
  const steps = useVisibleOnboardingSteps();
  const { resume, isPending } = useResumeSetup();
  const [open, setOpen] = useState(false);
  // Setup writes swarm config: only an admin can finish it.
  const canSetup = useCan("config.write.any");

  if (!canSetup || !data || !isOnboardingOpen(data)) return null;
  const { state } = data;
  // Pill, ring, and popover all count done steps ("Setup 3/7", "3 / 7 verified").
  const done = onboardingDoneCount(state, steps);
  const resumeStep = onboardingResumeStep(state, steps);
  const total = steps.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Setup: ${done} of ${total} steps done`}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-primary/40 bg-card pr-3 pl-2 text-xs font-semibold whitespace-nowrap",
            "hover:bg-accent hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            "data-[state=open]:border-primary/60 data-[state=open]:bg-primary/10",
          )}
        >
          <ProgressRing value={done} total={total} />
          <span>
            Setup {done}/{total}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 overflow-hidden rounded-xl p-0">
        <div className="flex items-center gap-2 border-b border-border-subtle bg-surface px-3.5 py-2.5">
          <p className="flex-1 text-sm font-semibold">Finish setting up</p>
          <SetupChip>
            {done} / {total} verified
          </SetupChip>
        </div>
        <ul className="divide-y divide-border-subtle">
          {steps.map(({ id, label }) => {
            const status = state.steps[id].status;
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => void resume(id)}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] hover:bg-accent hover-linger transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                >
                  <StepStatusGlyph status={status} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      status === "done" && "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {STEP_STATUS_WORD[status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-2 border-t border-border-subtle bg-surface px-3.5 py-2.5">
          <p className="flex-1 text-xs text-muted-foreground">
            Resume opens step {stepNumber(resumeStep, steps)}.
          </p>
          <Button size="sm" disabled={isPending} onClick={() => void resume(resumeStep)}>
            Resume
            <ArrowRight />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 17px ring: muted track, amber arc for the done share. */
function ProgressRing({ value, total }: { value: number; total: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 18 18" className="size-[17px] shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="3" className="stroke-border" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        strokeWidth="3"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - value / total)}
        className="stroke-primary"
      />
    </svg>
  );
}
