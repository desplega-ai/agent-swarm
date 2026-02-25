import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentStatus, AgentTaskStatus, EpicStatus, ServiceStatus } from "@/api/types";

type Status = AgentStatus | AgentTaskStatus | EpicStatus | ServiceStatus;

interface StatusConfig {
  label: string;
  className: string;
  pulse?: boolean;
}

const statusConfig: Record<string, StatusConfig> = {
  // Agent statuses
  idle: { label: "Idle", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  busy: {
    label: "Busy",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pulse: true,
  },
  offline: { label: "Offline", className: "bg-red-500/15 text-red-400 border-red-500/30" },

  // Task statuses
  backlog: { label: "Backlog", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  unassigned: {
    label: "Unassigned",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  },
  offered: {
    label: "Offered",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pulse: true,
  },
  reviewing: {
    label: "Reviewing",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  pending: { label: "Pending", className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  in_progress: {
    label: "In Progress",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pulse: true,
  },
  paused: { label: "Paused", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  completed: {
    label: "Completed",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-400 border-red-500/30" },
  cancelled: {
    label: "Cancelled",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  },

  // Epic statuses
  draft: { label: "Draft", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  active: {
    label: "Active",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pulse: true,
  },

  // Service statuses
  starting: {
    label: "Starting",
    className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  },
  healthy: {
    label: "Healthy",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  unhealthy: { label: "Unhealthy", className: "bg-red-500/15 text-red-400 border-red-500/30" },
  stopped: { label: "Stopped", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

interface StatusBadgeProps {
  status: Status;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({ status, size = "sm", className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? {
    label: status,
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  };

  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono font-semibold tracking-wide uppercase border",
        config.className,
        config.pulse && "animate-pulse",
        size === "sm" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5",
        className,
      )}
    >
      {config.label}
    </Badge>
  );
}
