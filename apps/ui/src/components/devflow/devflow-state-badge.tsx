import type { DevFlowState } from "@/api/devflow-types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const toneByState: Record<DevFlowState, string> = {
  captured: "border-status-neutral/30 text-status-neutral-strong",
  triaged: "border-status-info/30 text-status-info-strong",
  scoped: "border-status-pending/30 text-status-pending-strong",
  specced: "border-status-paused/30 text-status-paused-strong",
  sized: "border-status-info/30 text-status-info-strong",
  planned: "border-status-pending/30 text-status-pending-strong",
  building: "border-status-active/30 text-status-active-strong",
  in_review: "border-status-paused/30 text-status-paused-strong",
  deployed: "border-status-info/30 text-status-info-strong",
  monitoring: "border-status-active/30 text-status-active-strong",
  done: "border-status-success/30 text-status-success-strong",
  blocked: "border-status-error/30 text-status-error-strong",
  archived: "border-status-neutral/30 text-status-neutral-strong",
};

export function DevFlowStateBadge({
  state,
  className,
}: {
  state: DevFlowState;
  className?: string;
}) {
  return (
    <Badge variant="outline" size="tag" className={cn(toneByState[state], className)}>
      {state.replace("_", " ")}
    </Badge>
  );
}
