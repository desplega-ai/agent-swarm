/**
 * Sessions surface (Phase 4 ≥1.76.0) — task card rendered inside the timeline.
 *
 * Composed from the shadcn `<Card>` primitive (per ui/CLAUDE.md compose-only
 * rule). Click opens a `<TaskDetailSheet>` with the existing transcript + log
 * components — no new transcript code is introduced.
 *
 * Body (collapsed-by-default):
 *   - status pill via <StatusBadge>
 *   - agent name via <AgentLink> (or "Unassigned" when agentId is null)
 *   - relative started-at
 *   - top 1-2 cached log entries from the QueryClient cache
 *     (`["task", id, "session-logs"]` — populated as soon as TaskDetailSheet
 *      opens. Pre-open we have nothing to show, which is fine — the card
 *      stays compact.)
 */

import { useQueryClient } from "@tanstack/react-query";
import { CornerDownRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentTask, SessionLog } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatRelativeTime } from "@/lib/utils";
import { TaskDetailSheet } from "./task-detail-sheet";

export interface TaskCardProps {
  task: AgentTask;
  /**
   * `true` when this card is rendered as a direct child of <ParallelGroup>.
   * Lets us drop the outer card chrome to ride inside the group's border.
   */
  insideParallelGroup?: boolean;
  /** `true` when this is the root (session-starting) task. Adds a ROOT pill. */
  isRoot?: boolean;
  className?: string;
}

/** First non-empty line of a session log line, trimmed. */
function summarizeLog(log: SessionLog): string {
  const firstLine = log.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim().slice(0, 120);
}

export function TaskCard({ task, insideParallelGroup, isRoot, className }: TaskCardProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  // Read the cached session logs (populated once the user has opened the
  // sheet at least once — or once any other surface fetched them). Pre-cache
  // we render the title only.
  const cachedLogs = queryClient.getQueryData<SessionLog[]>(["task", task.id, "session-logs"]);
  const summaryLines = useMemo(() => {
    if (!cachedLogs || cachedLogs.length === 0) return [] as string[];
    return cachedLogs
      .slice(-2)
      .map(summarizeLog)
      .filter((s) => s.length > 0);
  }, [cachedLogs]);

  return (
    <>
      <Card
        data-slot="session-task-card"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={`Open task ${task.id}`}
        className={cn(
          "cursor-pointer transition-colors hover:bg-muted/30 py-3 gap-2",
          isRoot && "border-l-2 border-l-primary",
          insideParallelGroup && "border-0 shadow-none rounded-none bg-transparent py-2",
          className,
        )}
      >
        <CardContent
          className={cn("px-4 flex flex-col gap-1.5", insideParallelGroup && "pl-7 relative")}
        >
          {insideParallelGroup ? (
            <CornerDownRight
              aria-hidden="true"
              className="absolute left-2 top-2 h-3 w-3 text-muted-foreground/60"
            />
          ) : null}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {isRoot ? (
                <Badge variant="outline" size="tag" className="shrink-0">
                  ROOT
                </Badge>
              ) : null}
              <p className="text-sm font-medium truncate min-w-0">{task.task}</p>
            </div>
            <StatusBadge status={task.status} className="shrink-0" />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {task.agentId ? (
              <AgentLink agentId={task.agentId} />
            ) : (
              <span className="font-mono text-xs">Unassigned</span>
            )}
            <span aria-hidden="true">·</span>
            <span>{formatRelativeTime(task.createdAt)}</span>
          </div>

          {summaryLines.length > 0 && (
            <ul className="text-xs text-muted-foreground space-y-0.5 mt-0.5">
              {summaryLines.map((line, idx) => (
                <li key={idx} className="truncate">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <TaskDetailSheet taskId={task.id} task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

export interface ParallelGroupProps {
  count: number;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wrapper for siblings sharing a `parentTaskId`. Uses neutral design tokens
 * (no raw palette literals — would fail `pnpm check:tokens`).
 */
export function ParallelGroup({ count, children, className }: ParallelGroupProps) {
  return (
    <div
      data-slot="session-parallel-group"
      className={cn("border border-border bg-muted/30 rounded-md overflow-hidden", className)}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-mono font-medium">
          parallel · {count} tasks
        </span>
      </div>
      <div className="flex flex-col divide-y divide-border">{children}</div>
    </div>
  );
}
