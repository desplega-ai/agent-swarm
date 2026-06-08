import { Loader2 } from "lucide-react";
import type {
  AgentStatus,
  AgentTaskStatus,
  ApprovalRequestStatus,
  ScriptRunStatus,
  ServiceStatus,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
} from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status =
  | AgentStatus
  | AgentTaskStatus
  | ApprovalRequestStatus
  | ServiceStatus
  | ScriptRunStatus
  | WorkflowRunStatus
  | WorkflowRunStepStatus;

interface StatusConfig {
  label: string;
  dot: string;
  text: string;
  spinner?: boolean;
}

const statusConfig: Record<string, StatusConfig> = {
  // Agent statuses
  idle: { label: "IDLE", dot: "bg-status-success", text: "text-status-success-strong" },
  busy: {
    label: "BUSY",
    dot: "bg-status-active",
    text: "text-status-active-strong",
    spinner: true,
  },
  offline: { label: "OFFLINE", dot: "bg-status-neutral", text: "text-status-neutral" },
  waiting_for_credentials: {
    label: "WAITING FOR CREDS",
    dot: "bg-status-warning",
    text: "text-status-warning-strong",
  },

  // Task statuses
  backlog: { label: "BACKLOG", dot: "bg-status-neutral", text: "text-status-neutral" },
  unassigned: { label: "UNASSIGNED", dot: "bg-status-neutral", text: "text-status-neutral" },
  offered: {
    label: "OFFERED",
    dot: "bg-status-active",
    text: "text-status-active-strong",
    spinner: true,
  },
  reviewing: { label: "REVIEWING", dot: "bg-status-paused", text: "text-status-paused-strong" },
  pending: { label: "PENDING", dot: "bg-status-pending", text: "text-status-pending-strong" },
  in_progress: {
    label: "IN PROGRESS",
    dot: "bg-status-active",
    text: "text-status-active-strong",
    spinner: true,
  },
  paused: { label: "PAUSED", dot: "bg-status-paused", text: "text-status-paused-strong" },
  completed: {
    label: "COMPLETED",
    dot: "bg-status-success",
    text: "text-status-success-strong",
  },
  failed: { label: "FAILED", dot: "bg-status-error", text: "text-status-error-strong" },
  cancelled: { label: "CANCELLED", dot: "bg-status-neutral", text: "text-status-neutral" },
  superseded: { label: "SUPERSEDED", dot: "bg-status-neutral", text: "text-status-neutral" },
  aborted_limit: {
    label: "ABORTED LIMIT",
    dot: "bg-status-warning",
    text: "text-status-warning-strong",
  },

  // Service statuses
  starting: {
    label: "STARTING",
    dot: "bg-status-pending",
    text: "text-status-pending-strong",
  },
  healthy: {
    label: "HEALTHY",
    dot: "bg-status-success",
    text: "text-status-success-strong",
  },
  unhealthy: { label: "UNHEALTHY", dot: "bg-status-error", text: "text-status-error-strong" },
  stopped: { label: "STOPPED", dot: "bg-status-neutral", text: "text-status-neutral" },

  // Workflow run statuses
  running: {
    label: "RUNNING",
    dot: "bg-status-active",
    text: "text-status-active-strong",
    spinner: true,
  },
  waiting: { label: "WAITING", dot: "bg-status-pending", text: "text-status-pending-strong" },

  // Workflow step statuses
  skipped: { label: "SKIPPED", dot: "bg-status-neutral", text: "text-status-neutral" },

  // Approval request statuses
  approved: {
    label: "APPROVED",
    dot: "bg-status-success",
    text: "text-status-success-strong",
  },
  rejected: { label: "REJECTED", dot: "bg-status-error", text: "text-status-error-strong" },
  timeout: { label: "TIMEOUT", dot: "bg-status-warning", text: "text-status-warning-strong" },
} satisfies Record<string, StatusConfig>;

interface StatusBadgeProps {
  status: Status;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({ status, size = "sm", className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? {
    label: status,
    dot: "bg-status-neutral",
    text: "text-status-neutral",
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
