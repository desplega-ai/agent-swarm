/**
 * Steering — segmented Queue / Interrupt control.
 *
 * There is no `ToggleGroup` / `RadioGroup` primitive in `components/ui/`, and
 * this control is small enough that pulling one in would be a dependency for
 * two buttons. It is composed from `ghost` `Button`s instead: an amber pill
 * sits behind the selected segment and slides between segments on a spring
 * (the `/setup` stepper pattern). Reduced motion drops the slide.
 *
 * Decision 16 — we never offer a mode the target harness can't honor. When
 * `canInterrupt` is false the Interrupt segment renders as unavailable with the
 * reason on hover/focus, rather than accepting the click and silently
 * downgrading. It uses `aria-disabled` + a no-op click rather than the
 * `disabled` attribute so it stays focusable and hoverable — a natively
 * disabled button swallows the pointer/focus events the tooltip needs.
 */

import { Clock, Zap } from "lucide-react";
import { motion, type Transition } from "motion/react";
import { useId } from "react";
import type { SteerMode } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Same spring as the `/setup` stepper pill. */
const SPRING: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };

/** Amber pill behind the selected segment. `layoutId` slides it between segments. */
function ActivePill({ layoutId }: { layoutId: string }) {
  return (
    <motion.span
      layoutId={layoutId}
      transition={SPRING}
      // Motion corrects the radius under layout scale only when it is a style (6px = rounded-sm).
      style={{ borderRadius: 6 }}
      aria-hidden="true"
      className="absolute inset-0 -z-10 bg-primary shadow-xs"
    />
  );
}

/** Selected segment: amber text-on-pill that keeps its color on hover. */
const SELECTED = "text-primary-foreground hover:bg-transparent hover:text-primary-foreground";

export interface SteerModeToggleProps {
  value: SteerMode;
  onChange: (mode: SteerMode) => void;
  /** False when `supportedSteerModes` lacks `"steer"` (claude). */
  canInterrupt: boolean;
  /** Shown on hover/focus over the unavailable Interrupt segment. */
  interruptDisabledReason?: string;
  /** Hard-disables both segments (no identity picked, or a send in flight). */
  disabled?: boolean;
  className?: string;
}

export function SteerModeToggle({
  value,
  onChange,
  canInterrupt,
  interruptDisabledReason,
  disabled,
  className,
}: SteerModeToggleProps) {
  // One pill per toggle instance, so two composers never share a slide.
  const pillId = useId();
  const interruptButton = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      disabled={disabled}
      aria-pressed={value === "steer"}
      aria-disabled={canInterrupt ? undefined : true}
      onClick={() => {
        if (!canInterrupt) return;
        onChange("steer");
      }}
      className={cn(
        "relative isolate rounded-sm px-2",
        value === "steer" && SELECTED,
        canInterrupt ? null : "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {value === "steer" ? <ActivePill layoutId={pillId} /> : null}
      <Zap />
      Interrupt
    </Button>
  );

  return (
    <fieldset
      aria-label="Steering mode"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5",
        className,
      )}
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={disabled}
        aria-pressed={value === "queue"}
        onClick={() => onChange("queue")}
        className={cn("relative isolate rounded-sm px-2", value === "queue" && SELECTED)}
      >
        {value === "queue" ? <ActivePill layoutId={pillId} /> : null}
        <Clock />
        Queue
      </Button>
      {canInterrupt ? (
        interruptButton
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{interruptButton}</TooltipTrigger>
          <TooltipContent side="top">
            {interruptDisabledReason ?? "Interrupt isn't supported by this harness."}
          </TooltipContent>
        </Tooltip>
      )}
    </fieldset>
  );
}
