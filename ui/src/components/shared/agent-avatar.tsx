/**
 * Small colored disc with a per-agent icon (lead = crown, workers = one of
 * 30 deterministic icons seeded by agent id). Color is seeded by agent id
 * so the same agent appears with the same accent across the app — name
 * changes don't shift it.
 */

import { useAgent } from "@/api/hooks/use-agents";
import { getAgentColorToken, solidBg } from "@/lib/agent-color";
import { getAgentIcon } from "@/lib/agent-icon";
import { cn } from "@/lib/utils";

const SIZES: Record<"xs" | "sm" | "md" | "lg", { box: string; icon: string }> = {
  xs: { box: "h-5 w-5", icon: "h-3 w-3" },
  sm: { box: "h-6 w-6", icon: "h-3.5 w-3.5" },
  md: { box: "h-7 w-7", icon: "h-4 w-4" },
  lg: { box: "h-9 w-9", icon: "h-5 w-5" },
};

export interface AgentAvatarProps {
  agentId?: string | null;
  /** Optional pre-known name to avoid waiting on useAgent. */
  agentName?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}

export function AgentAvatar({ agentId, agentName, size = "md", className }: AgentAvatarProps) {
  const { data: agent } = useAgent(agentId ?? "");
  const name = agentName ?? agent?.name ?? null;
  const token = getAgentColorToken({
    agentId: agentId ?? null,
    agentName: name,
    role: agent?.role ?? null,
  });
  const Icon = getAgentIcon({
    agentId: agentId ?? null,
    isLead: agent?.isLead ?? null,
    role: agent?.role ?? null,
    agentName: name,
  });
  const dims = SIZES[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center rounded-full text-white shadow-sm",
        dims.box,
        solidBg(token),
        className,
      )}
    >
      <Icon className={dims.icon} strokeWidth={2.25} />
    </span>
  );
}
