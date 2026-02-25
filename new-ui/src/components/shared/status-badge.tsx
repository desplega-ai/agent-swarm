import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentStatus, AgentTaskStatus, EpicStatus, ServiceStatus } from "@/api/types";

type Status = AgentStatus | AgentTaskStatus | EpicStatus | ServiceStatus;

interface StatusConfig {
  label: string;
  dot: string;
  text: string;
  pulse?: boolean;
}

const statusConfig: Record<string, StatusConfig> = {
  // Agent statuses
  idle: { label: "Idle", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  busy: { label: "Busy", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", pulse: true },
  offline: { label: "Offline", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },

  // Task statuses
  backlog: { label: "Backlog", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  unassigned: { label: "Unassigned", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  offered: { label: "Offered", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", pulse: true },
  reviewing: { label: "Reviewing", dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
  pending: { label: "Pending", dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
  in_progress: { label: "In Progress", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", pulse: true },
  paused: { label: "Paused", dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
  completed: { label: "Completed", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  cancelled: { label: "Cancelled", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },

  // Epic statuses
  draft: { label: "Draft", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  active: { label: "Active", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", pulse: true },

  // Service statuses
  starting: { label: "Starting", dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
  healthy: { label: "Healthy", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  unhealthy: { label: "Unhealthy", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  stopped: { label: "Stopped", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
} satisfies Record<string, StatusConfig>;

interface StatusBadgeProps {
  status: Status;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({ status, size = "sm", className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? {
    label: status,
    dot: "bg-zinc-400",
    text: "text-zinc-500 dark:text-zinc-400",
  };

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-medium",
        size === "sm" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5",
        className,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full shrink-0",
          config.dot,
          config.pulse && "animate-pulse",
        )}
      />
      <span className={config.text}>{config.label}</span>
    </Badge>
  );
}
