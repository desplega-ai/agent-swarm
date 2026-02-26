import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { AgentStatus, AgentTaskStatus, EpicStatus, ServiceStatus } from "@/api/types";

type Status = AgentStatus | AgentTaskStatus | EpicStatus | ServiceStatus;

interface StatusConfig {
  label: string;
  dot: string;
  text: string;
  spinner?: boolean;
}

const statusConfig: Record<string, StatusConfig> = {
  // Agent statuses
  idle: { label: "IDLE", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  busy: { label: "BUSY", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", spinner: true },
  offline: { label: "OFFLINE", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },

  // Task statuses
  backlog: { label: "BACKLOG", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  unassigned: { label: "UNASSIGNED", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  offered: { label: "OFFERED", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", spinner: true },
  reviewing: { label: "REVIEWING", dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
  pending: { label: "PENDING", dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
  in_progress: { label: "IN PROGRESS", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", spinner: true },
  paused: { label: "PAUSED", dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
  completed: { label: "COMPLETED", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "FAILED", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  cancelled: { label: "CANCELLED", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },

  // Epic statuses
  draft: { label: "DRAFT", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  active: { label: "ACTIVE", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", spinner: true },

  // Service statuses
  starting: { label: "STARTING", dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
  healthy: { label: "HEALTHY", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  unhealthy: { label: "UNHEALTHY", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  stopped: { label: "STOPPED", dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
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
        "gap-1.5 font-medium leading-none items-center",
        size === "sm" ? "text-[9px] px-1.5 py-0 h-5" : "text-[10px] px-2 py-0 h-6",
        className,
      )}
    >
      {config.spinner ? (
        <Loader2 className={cn("h-3 w-3 shrink-0 animate-spin", config.text)} />
      ) : (
        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", config.dot)} />
      )}
      <span className={config.text}>{config.label}</span>
    </Badge>
  );
}
