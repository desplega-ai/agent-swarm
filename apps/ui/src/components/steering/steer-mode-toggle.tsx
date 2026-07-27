/**
 * Steering — segmented Queue / Interrupt control.
 *
 * There is no `ToggleGroup` / `RadioGroup` primitive in `components/ui/`, and
 * this control is small enough that pulling one in would be a dependency for
 * two buttons. It is composed from `Button` variants instead: the selected
 * segment takes `default` (amber primary), the other `ghost`.
 *
 * Decision 16 — we never offer a mode the target harness can't honor. When
 * `canInterrupt` is false the Interrupt segment renders as unavailable with the
 * reason on hover/focus, rather than accepting the click and silently
 * downgrading. It uses `aria-disabled` + a no-op click rather than the
 * `disabled` attribute so it stays focusable and hoverable — a natively
 * disabled button swallows the pointer/focus events the tooltip needs.
 */

import { Clock, Zap } from "lucide-react";
import type { SteerMode } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
  const interruptButton = (
    <Button
      type="button"
      size="xs"
      variant={value === "steer" ? "default" : "ghost"}
      disabled={disabled}
      aria-pressed={value === "steer"}
      aria-disabled={canInterrupt ? undefined : true}
      onClick={() => {
        if (!canInterrupt) return;
        onChange("steer");
      }}
      className={cn(
        "rounded-sm px-2",
        canInterrupt ? null : "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
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
        variant={value === "queue" ? "default" : "ghost"}
        disabled={disabled}
        aria-pressed={value === "queue"}
        onClick={() => onChange("queue")}
        className="rounded-sm px-2"
      >
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
