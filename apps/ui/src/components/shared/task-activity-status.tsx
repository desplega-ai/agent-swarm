import { AlertTriangle } from "lucide-react";
import type { AgentTaskStatus } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import {
  classifyTaskActivity,
  formatTaskActivityAge,
  type TaskActivityTone,
} from "@/lib/task-activity";
import { cn } from "@/lib/utils";

const TONE_CLASSES: Record<TaskActivityTone, string> = {
  active: "border-status-active/30 bg-status-active/5 text-status-active-strong",
  warning: "border-status-warning/30 bg-status-warning/5 text-status-warning-strong",
  pending: "border-status-pending/30 bg-status-pending/5 text-status-pending-strong",
  paused: "border-status-paused/30 bg-status-paused/5 text-status-paused-strong",
  success: "border-status-success/30 bg-status-success/5 text-status-success-strong",
  error: "border-status-error/30 bg-status-error/5 text-status-error-strong",
  neutral: "border-border bg-muted/30 text-muted-foreground",
};

export function TaskActivityStatus({
  status,
  lastActivityAt,
  nowMs,
  className,
}: {
  status: AgentTaskStatus | undefined;
  lastActivityAt: string | undefined;
  nowMs?: number;
  className?: string;
}) {
  const activity = classifyTaskActivity(status, lastActivityAt, nowMs);
  const age = formatTaskActivityAge(activity.ageMs);

  return (
    <div
      className={cn("flex min-w-0 flex-col items-start gap-1", className)}
      data-task-activity={activity.kind}
    >
      <Badge
        variant="outline"
        size="tag"
        className={cn("max-w-full gap-1", TONE_CLASSES[activity.tone])}
      >
        {activity.mayBeStuck ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> : null}
        <span className="truncate">{activity.label}</span>
      </Badge>
      <span
        className="max-w-full truncate text-[10px] font-normal leading-none normal-case tracking-normal text-muted-foreground"
        title={lastActivityAt}
      >
        Last activity {age}
      </span>
    </div>
  );
}
