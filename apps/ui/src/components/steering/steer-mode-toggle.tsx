/**
 * Steering: the Queue / Interrupt choice, as a `SegmentedControl` (radio
 * group with the sliding amber pill).
 *
 * Decision 16: we never offer a mode the target harness can't honor. When
 * `canInterrupt` is false, the Interrupt option is unavailable: a click,
 * Enter, or Space does nothing, instead of silently downgrading.
 * `SegmentedControl` marks it `aria-disabled` (not `disabled`), so the
 * pointer and the arrow keys still reach it. Its tooltip shows the reason on
 * hover and focus, and screen readers read the reason as the option's
 * description.
 */

import { Clock, Zap } from "lucide-react";
import type { SteerMode } from "@/api/types";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";

export interface SteerModeToggleProps {
  value: SteerMode;
  onChange: (mode: SteerMode) => void;
  /** False when `supportedSteerModes` lacks `"steer"` (claude). */
  canInterrupt: boolean;
  /** Shown on hover/focus over the unavailable Interrupt option. */
  interruptDisabledReason?: string;
  /** Hard-disables both options (no identity picked, or a send in flight). */
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
  const options: SegmentedControlOption<SteerMode>[] = [
    {
      value: "queue",
      label: (
        <>
          <Clock />
          Queue
        </>
      ),
    },
    {
      value: "steer",
      label: (
        <>
          <Zap />
          Interrupt
        </>
      ),
      disabled: !canInterrupt,
      tooltip: canInterrupt
        ? undefined
        : (interruptDisabledReason ?? "Interrupt isn't supported by this harness."),
    },
  ];

  return (
    <SegmentedControl
      aria-label="Steering mode"
      size="sm"
      value={value}
      onValueChange={onChange}
      options={options}
      disabled={disabled}
      className={className}
    />
  );
}
