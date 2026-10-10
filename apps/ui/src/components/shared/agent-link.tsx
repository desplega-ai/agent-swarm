import { Link } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import { cn } from "@/lib/utils";

/**
 * Renders an agent link that resolves the agent name via the API.
 * Falls back to a truncated ID while loading or if the agent is not found.
 */
export function AgentLink({
  agentId,
  onClick,
  className,
}: {
  agentId: string;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const { data: agent } = useAgent(agentId);
  const label = agent?.name ?? `${agentId.slice(0, 8)}\u2026`;

  return (
    <Link
      to={`/agents/${agentId}`}
      className={cn("text-primary hover:underline font-mono text-xs", className)}
      onClick={onClick}
    >
      {label}
    </Link>
  );
}
