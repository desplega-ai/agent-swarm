import { ONBOARDING_STEPS } from "@/api/hooks/use-onboarding";
import type { OnboardingStepId, OnboardingStepStatus } from "@/api/types";
import {
  SKIPPED_HATCH,
  STEP_STATUS_WORD,
  StepStatusGlyph,
} from "@/components/onboarding/step-status";
import { cn } from "@/lib/utils";

interface SetupProgressProps {
  statuses: Record<OnboardingStepId, OnboardingStepStatus>;
  /** Steps done or skipped (`onboardingSettledCount`). */
  settled: number;
  current: OnboardingStepId;
  /** Omit to make the overview read-only (no connection yet). */
  onSelect?: (step: OnboardingStepId) => void;
}

/**
 * One linear bar split into six equal slices (done = amber, skipped = hatched,
 * failed = red, current = faint amber tint), and the clickable step overview
 * under it. Below 640px the overview shows step numbers only.
 */
export function SetupProgress({ statuses, settled, current, onSelect }: SetupProgressProps) {
  return (
    <div className="mx-auto w-full max-w-[840px] px-3 pt-3 sm:px-5">
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={ONBOARDING_STEPS.length}
        aria-valuenow={settled}
        className="flex h-[5px] overflow-hidden rounded-full bg-border"
      >
        {ONBOARDING_STEPS.map(({ id }, index) => {
          const status = statuses[id];
          return (
            <div
              key={id}
              className={cn(
                "relative h-full min-w-0 flex-1",
                index > 0 && "border-l border-background",
                id === current && "bg-primary/20",
              )}
            >
              {/* Fill grows from the left on scaleX (transform only). */}
              <div
                style={status === "skipped" ? SKIPPED_HATCH : undefined}
                className={cn(
                  "absolute inset-0 origin-left transition-transform duration-200 ease-snappy motion-reduce:transition-none",
                  status === "todo" ? "scale-x-0" : "scale-x-100",
                  status === "done" && "bg-primary",
                  status === "failed" && "bg-status-error",
                  status === "skipped" && "bg-status-neutral/20",
                )}
              />
            </div>
          );
        })}
      </div>

      <nav aria-label="Setup steps" className="flex gap-px pt-1.5 pb-2">
        {ONBOARDING_STEPS.map(({ id, label }, index) => {
          const status = statuses[id];
          const isCurrent = id === current;
          return (
            <button
              key={id}
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(id)}
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`Step ${index + 1}: ${label}, ${STEP_STATUS_WORD[status]}`}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-0.5 py-1 text-[11px] leading-tight text-muted-foreground sm:justify-start sm:px-1.5",
                "transition-colors hover-linger enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                (isCurrent || status === "done") && "text-foreground",
                isCurrent && "font-semibold",
              )}
            >
              <StepStatusGlyph status={status} current={isCurrent} />
              <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">{label}</span>
              <span className="font-mono sm:hidden">{index + 1}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
