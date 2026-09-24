import { Check, X } from "lucide-react";
import type { CSSProperties } from "react";
import { ONBOARDING_STEPS } from "@/api/hooks/use-onboarding";
import type { OnboardingStepId, OnboardingStepStatus } from "@/api/types";
import { cn } from "@/lib/utils";
import { SetupChip, type SetupChipTone } from "./setup-card";

/**
 * Shared step-status vocabulary for the `/setup` overview, the header Setup
 * pill, and the home checklist card, so all three read the same.
 */

/** Diagonal hatch for skipped steps (progress slice, glyphs). Token colors only. */
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

const STEP_CHIP_TONE: Record<OnboardingStepStatus, SetupChipTone> = {
  done: "success",
  skipped: "neutral",
  failed: "error",
  todo: "neutral",
};

export function StepStatusChip({ status }: { status: OnboardingStepStatus }) {
  return <SetupChip tone={STEP_CHIP_TONE[status]}>{STEP_STATUS_WORD[status]}</SetupChip>;
}

/** 1-based position of a step, as used in `?step=N` and "Step N of 6". */
export function stepNumber(id: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex((step) => step.id === id) + 1;
}

export function setupStepHref(id: OnboardingStepId): string {
  return `/setup?step=${stepNumber(id)}`;
}

/**
 * Round status glyph: check (done), hatched (skipped), red x (failed), empty
 * (to do). `current` adds the amber ring of the step on screen.
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
        "grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px] border-border",
        status === "done" &&
          "border-status-success/55 bg-status-success/15 text-status-success-strong",
        status === "failed" && "border-status-error/55 bg-status-error/15 text-status-error-strong",
        status === "skipped" && "border-status-neutral/40",
        current && "ring-2 ring-primary/25",
        current && status === "todo" && "border-primary",
        className,
      )}
    >
      {status === "done" ? <Check className="size-[9px]" strokeWidth={3.5} /> : null}
      {status === "failed" ? <X className="size-[9px]" strokeWidth={3.5} /> : null}
    </span>
  );
}
