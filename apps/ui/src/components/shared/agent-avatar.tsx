/**
 * Small colored disc with a per-agent icon. Prefers the agent's stored
 * `avatar` (custom icon + color, overriding even the lead crown — an
 * explicit choice always wins); falls back to the deterministic
 * hash-derived icon/color (lead = crown, workers = one of 30 icons seeded
 * by agent id) when unset. Color is seeded by agent id so the same agent
 * appears with the same accent across the app — name changes don't shift it.
 * A link or agent-fs avatar fills the disc as an image, with the deterministic
 * glyph underneath while it loads or when it cannot show.
 */

import { useAgent } from "@/api/hooks/use-agents";
import { MediaIconGlyph } from "@/components/shared/media-icon-glyph";
import { resolveAgentColor, solidBg } from "@/lib/agent-color";
import { resolveAgentIcon } from "@/lib/agent-icon";
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
  const color = resolveAgentColor(agent?.avatar, {
    agentId: agentId ?? null,
    agentName: name,
    role: agent?.role ?? null,
  });
  const Icon = resolveAgentIcon(agent?.avatar, {
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
        "inline-flex items-center justify-center overflow-hidden rounded-full text-white shadow-sm",
        dims.box,
        color.kind === "token" && solidBg(color.token),
        className,
      )}
      style={color.kind === "custom" ? { backgroundColor: color.hex } : undefined}
    >
      {agent?.avatar?.type === "url" || agent?.avatar?.type === "agent-fs" ? (
        // The image covers the disc; while it loads or if it cannot show, the
        // deterministic glyph on the colored disc holds the slot. The image gets
        // an opaque backdrop so a transparent one does not show the disc color.
        <MediaIconGlyph
          icon={agent.avatar}
          fallback={Icon}
          className={dims.icon}
          imageClassName="size-full rounded-full bg-background"
        />
      ) : (
        <Icon className={dims.icon} strokeWidth={2.25} />
      )}
    </span>
  );
}
