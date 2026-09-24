import { Check, X } from "lucide-react";
import type { CSSProperties } from "react";
import { ONBOARDING_STEPS } from "@/api/hooks/use-onboarding";
import type { OnboardingStepId, OnboardingStepStatus } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SetupChip } from "./setup-card";

/**
 * Shared step-status vocabulary for the `/setup` header stepper, the header
 * Setup pill, and the home checklist card, so all three read the same.
 * Progress is amber (the brand accent): a done step never uses the green
 * success tone next to it.
 */

/** Diagonal hatch for skipped steps (glyphs, stepper). Token colors only. */
export const SKIPPED_HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(115deg, color-mix(in oklch, var(--color-status-neutral) 55%, transparent) 0 1.5px, transparent 1.5px 4px)",
};

/** The one word per status, in lists, chips, and labels. */
export const STEP_STATUS_WORD: Record<OnboardingStepStatus, string> = {
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
  todo: "To do",
};

/** Border, fill, and text tone of a round or square step marker. */
export const STEP_TONE_CLASS: Record<OnboardingStepStatus, string> = {
  done: "border-primary/45 bg-primary/15 text-primary",
  failed: "border-status-error/55 bg-status-error/15 text-status-error-strong",
  skipped: "border-status-neutral/40 text-muted-foreground",
  todo: "border-border text-muted-foreground",
};

export function StepStatusChip({ status }: { status: OnboardingStepStatus }) {
  if (status === "done") {
    return (
      <Badge variant="outline" size="tag" className="border-primary/30 text-primary">
        {STEP_STATUS_WORD.done}
      </Badge>
    );
  }
  return (
    <SetupChip tone={status === "failed" ? "error" : "neutral"}>
      {STEP_STATUS_WORD[status]}
    </SetupChip>
  );
}

/** 1-based position of a step, as used in `?step=N` and "Step N of 6". */
export function stepNumber(id: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex((step) => step.id === id) + 1;
}

export function setupStepHref(id: OnboardingStepId): string {
  return `/setup?step=${stepNumber(id)}`;
}

/**
 * Round status glyph: amber check (done), hatched (skipped), red x (failed),
 * empty (to do). `current` adds the amber ring of the step on screen.
 */
export function StepStatusGlyph({
  status,
  current = false,
  className,
}: {
  status: OnboardingStepStatus;
  current?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={status === "skipped" ? SKIPPED_HATCH : undefined}
      className={cn(
        "grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px]",
        STEP_TONE_CLASS[status],
        current && "ring-2 ring-primary/25",
        current && status === "todo" && "border-primary",
        className,
      )}
    >
      {status === "done" ? <Check className="size-3/4" strokeWidth={3.5} /> : null}
      {status === "failed" ? <X className="size-3/4" strokeWidth={3.5} /> : null}
    </span>
  );
}
