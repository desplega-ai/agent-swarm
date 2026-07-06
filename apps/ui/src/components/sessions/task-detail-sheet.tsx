/**
 * Sessions surface (Phase 4 ≥1.76.0) — task-detail Sheet, opened from a
 * timeline `<TaskCard>` click.
 *
 * Wraps shadcn `<Sheet side="right">` and re-uses the existing
 * `<SessionLogViewer>` / `useTaskSessionLogs` / `useTaskContext` /
 * `useSessionCosts` hooks. No new transcript code — all formatting + rendering
 * is delegated to the existing primitives so we inherit secret-scrubbing
 * (server-side) and parsing logic.
 */

import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useTaskContext, useTaskSessionLogs } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { taskIsRunning } from "@/lib/task-activity";
import { normalizeNewlines } from "@/lib/utils";

export interface TaskDetailSheetProps {
  taskId: string;
  /** Optional — pass the task object we already have so the header renders without a re-fetch. */
  task?: AgentTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export function TaskDetailSheet({ taskId, task, open, onOpenChange }: TaskDetailSheetProps) {
  // Only fetch once the sheet opens — keeps idle session-list pages cheap.
  const { data: logs, isLoading: logsLoading } = useTaskSessionLogs(open ? taskId : "");
  const { data: contextData } = useTaskContext(open ? taskId : "");
  const { data: costs, isLoading: costsLoading } = useSessionCosts({
    taskId,
    enabled: open,
  });

  const totalCost = costs?.reduce((sum, c) => sum + c.totalCostUsd, 0) ?? 0;
  const totalSessions = costs?.length ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl flex flex-col gap-0 p-0 overflow-hidden"
      >
        {/* Header — title + meta row (status, agent link, costs). Whole sheet
            is locked: only the transcript section scrolls. */}
        <SheetHeader className="border-b border-border pl-4 pr-12 py-3 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <SheetTitle className="text-sm font-medium truncate min-w-0">
                {task?.task ?? `Task ${taskId.slice(0, 8)}…`}
              </SheetTitle>
              <SheetDescription className="text-xs font-mono text-muted-foreground truncate">
                {taskId}
              </SheetDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {task ? <StatusBadge status={task.status} /> : null}
              <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                <Link
                  to={`/tasks/${taskId}`}
                  aria-label="Open task detail page"
                  title="Open task detail page"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        </SheetHeader>

        {/* Meta row — agent + cost summary above the transcript. */}
        <div className="border-b border-border px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground shrink-0 flex-wrap">
          {task?.agentId ? (
            <span className="flex items-center gap-1.5">
              <span className="uppercase tracking-wider text-[9px]">Agent</span>
              <AgentLink agentId={task.agentId} />
            </span>
          ) : (
            <span className="font-mono text-[11px]">Unassigned</span>
          )}
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-[9px]">Cost</span>
            {costsLoading ? (
              <Skeleton className="h-3 w-12" />
            ) : (
              <span className="font-mono">{usdFormatter.format(totalCost)}</span>
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-[9px]">Sessions</span>
            <span className="font-mono">{totalSessions}</span>
          </span>
        </div>

        {/* Body — single scroll surface containing Outcome (if any) +
            Transcript. The Sheet header / meta / section headers are
            shrink-0 above; this div is the only thing that scrolls. */}
        <div className="flex-1 min-h-0 overflow-auto">
          {task &&
          (task.status === "failed" || task.status === "cancelled") &&
          task.failureReason &&
          task.failureReason.trim().length > 0 ? (
            <section className="border-b border-border px-4 py-3 flex flex-col gap-2 min-w-0">
              <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-status-error-strong">
                {task.status === "cancelled" ? "Cancelled" : "Failure"}
              </h4>
              <div className="text-sm leading-relaxed text-status-error-strong min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                <Streamdown>{normalizeNewlines(task.failureReason.trim())}</Streamdown>
              </div>
            </section>
          ) : null}

          {task && task.status === "completed" && task.output && task.output.trim().length > 0 ? (
            <section className="border-b border-border px-4 py-3 flex flex-col gap-2 min-w-0">
              <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                Output
              </h4>
              <div className="text-sm leading-relaxed text-foreground/90 min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                <Streamdown>{normalizeNewlines(task.output.trim())}</Streamdown>
              </div>
            </section>
          ) : null}

          {open ? (
            <TaskAttachmentsSection taskId={taskId} attachments={undefined} className="mx-4 my-3" />
          ) : null}

          <section className="px-4 py-3 flex flex-col gap-2">
            <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Transcript
            </h4>
            {logsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : logs && logs.length > 0 ? (
              <SessionLogViewer
                logs={logs}
                compactionSnapshots={contextData?.snapshots}
                isRunning={taskIsRunning(task?.status)}
              />
            ) : (
              <p className="text-xs text-muted-foreground italic">No transcript yet.</p>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
