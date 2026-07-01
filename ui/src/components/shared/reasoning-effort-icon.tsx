import { Signal, SignalHigh, SignalLow, SignalMedium, SignalZero, Sparkles } from "lucide-react";
import type { ReasoningEffortLevel } from "@/api/types";
import { cn } from "@/lib/utils";

/**
 * Signal-strength metaphor, mirroring the agents-list badge's "more bars =
 * more effort" gradient: off has zero bars, xhigh has full bars. `Sparkles`
 * is reserved for the unset/"Auto" state (no override — harness default),
 * which isn't a `ReasoningEffortLevel` at all.
 */
export const REASONING_EFFORT_ICONS: Record<ReasoningEffortLevel, typeof Signal> = {
  off: SignalZero,
  low: SignalLow,
  medium: SignalMedium,
  high: SignalHigh,
  xhigh: Signal,
};

export const REASONING_EFFORT_LABEL: Record<ReasoningEffortLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
};

export const REASONING_EFFORT_DESCRIPTION: Record<ReasoningEffortLevel, string> = {
  off: "Disable extended reasoning",
  low: "Light reasoning effort",
  medium: "Balanced reasoning effort",
  high: "Deep reasoning effort",
  xhigh: "Maximum reasoning effort",
};

export const AUTO_LABEL = "Auto";
export const AUTO_DESCRIPTION = "No override — use the harness's own default";

/** Renders the level's signal-strength icon, or `Sparkles` for the unset/"Auto" state. */
export function ReasoningEffortIcon({
  level,
  className,
}: {
  level: ReasoningEffortLevel | null | undefined;
  className?: string;
}) {
  if (!level) return <Sparkles className={cn("h-3.5 w-3.5", className)} />;
  const Icon = REASONING_EFFORT_ICONS[level];
  return <Icon className={cn("h-3.5 w-3.5", className)} />;
}
