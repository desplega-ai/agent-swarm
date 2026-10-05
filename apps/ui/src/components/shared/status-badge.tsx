import type {
  AgentStatus,
  AgentTaskStatus,
  ApprovalRequestStatus,
  ScriptRunStatus,
  ServiceStatus,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
} from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import {
  TASK_STATUS_TEXT,
  TaskStatusIcon,
  taskStatusVariant,
} from "@/components/shared/task-status-icon";
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

/** Labels for every status; lifecycle ones are drawn by `TaskStatusIcon`, the rest by `HEALTH`. */
const LABELS: Record<string, string> = {
  // Agent statuses
  idle: "IDLE",
  busy: "BUSY",
  offline: "OFFLINE",
  waiting_for_credentials: "WAITING FOR CREDS",

  // Task statuses
  draft: "UPLOADING",
  backlog: "BACKLOG",
  unassigned: "UNASSIGNED",
  offered: "OFFERED",
  reviewing: "REVIEWING",
  pending: "PENDING",
  in_progress: "IN PROGRESS",
  paused: "PAUSED",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  superseded: "SUPERSEDED",
  aborted_limit: "ABORTED LIMIT",

  // Service statuses
  starting: "STARTING",
  healthy: "HEALTHY",
  unhealthy: "UNHEALTHY",
  stopped: "STOPPED",

  // Workflow run statuses
  running: "RUNNING",
  waiting: "WAITING",

  // Workflow step statuses
  skipped: "SKIPPED",

  // Approval request statuses
  approved: "APPROVED",
  rejected: "REJECTED",
  timeout: "TIMEOUT",
};

interface HealthConfig {
  dot: string;
  text: string;
  spinner?: boolean;
}

/** Agent and service health: a dot (or the busy spinner), not a lifecycle icon. */
const HEALTH: Record<string, HealthConfig> = {
  idle: { dot: "bg-status-success", text: "text-status-success-strong" },
  busy: { dot: "bg-status-active", text: "text-status-active-strong", spinner: true },
  offline: { dot: "bg-status-neutral", text: "text-status-neutral-strong" },
  waiting_for_credentials: { dot: "bg-status-warning", text: "text-status-warning-strong" },
  starting: { dot: "bg-status-pending", text: "text-status-pending-strong" },
  healthy: { dot: "bg-status-success", text: "text-status-success-strong" },
  unhealthy: { dot: "bg-status-error", text: "text-status-error-strong" },
  stopped: { dot: "bg-status-neutral", text: "text-status-neutral-strong" },
};

const FALLBACK_HEALTH: HealthConfig = {
  dot: "bg-status-neutral",
  text: "text-status-neutral-strong",
};

interface StatusBadgeProps {
  status: Status;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({ status, size = "sm", className }: StatusBadgeProps) {
  // Lifecycle statuses (tasks, runs, steps, approvals) get the status icon family;
  // agent and service health keep the dot (an idle agent is not a "done" task).
  const variant = taskStatusVariant(status);
  const health = HEALTH[status] ?? FALLBACK_HEALTH;
  const textClass = variant ? TASK_STATUS_TEXT[variant] : health.text;

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-medium leading-none items-center",
        size === "sm" ? "text-[9px] px-1.5 py-0 h-5" : "text-[10px] px-2 py-0 h-6",
        className,
      )}
    >
      {variant ? (
        // Wrapped so the badge's `[&>svg]:size-3` rule does not shrink the icon.
        <span className={cn("inline-flex shrink-0", size === "sm" ? "size-3.5" : "size-4")}>
          <TaskStatusIcon variant={variant} className="size-full" />
        </span>
      ) : health.spinner ? (
        <Spinner className={cn("size-3 shrink-0", health.text)} />
      ) : (
        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", health.dot)} />
      )}
      <span className={textClass}>{LABELS[status] ?? status}</span>
    </Badge>
  );
}
