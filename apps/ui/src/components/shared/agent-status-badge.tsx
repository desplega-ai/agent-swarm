import type { Agent } from "@/api/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface AgentStatusBadgeProps {
  agent: Pick<Agent, "status" | "onDemand">;
  size?: "sm" | "md";
  className?: string;
}

export const ON_DEMAND_TOOLTIP = "Ready. No runtime is up yet: sending a task starts one.";

/**
 * An agent's health chip. An offline pool agent that a sent task wakes reads
 * "On demand" (info tone), not plain offline, with a tooltip that says why.
 */
export function AgentStatusBadge({ agent, size, className }: AgentStatusBadgeProps) {
  if (agent.status !== "offline" || !agent.onDemand)
    return <StatusBadge status={agent.status} size={size} className={className} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <StatusBadge status="on_demand" size={size} className={className} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{ON_DEMAND_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}
