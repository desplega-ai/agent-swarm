import type { ReasoningEffortLevel } from "@/api/types";
import {
  REASONING_EFFORT_LABEL,
  ReasoningEffortIcon,
} from "@/components/shared/reasoning-effort-icon";
import { cn } from "@/lib/utils";

/**
 * The effort level's signal icon, shown next to a model. The level's name is
 * screen-reader text; callers put it in their tooltip. Unset and "off" render
 * nothing: the harness default applies, so there is no level to show.
 */
export function EffortMark({
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
