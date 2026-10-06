import type { ReasoningEffortLevel } from "@/api/types";
import {
  REASONING_EFFORT_LABEL,
  ReasoningEffortIcon,
} from "@/components/shared/reasoning-effort-icon";
import { cn } from "@/lib/utils";

/**
 * The effort level's signal icon, shown next to the model when the task sets
 * one. "off" gets no icon, the same as the agents list (`agent-model-cell`).
 */
export function TaskEffortMark({
  effort,
  className,
}: {
  effort?: ReasoningEffortLevel | null;
  className?: string;
}) {
  if (!effort || effort === "off") return null;
  return (
    <>
      <ReasoningEffortIcon level={effort} className={cn("h-3 w-3 shrink-0", className)} />
      <span className="sr-only">, {REASONING_EFFORT_LABEL[effort]} effort</span>
    </>
  );
}
