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
import { Check, ChevronDown, ChevronRight, Copy, CornerDownRight, Maximize2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import type { AgentTask, SessionLog } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn, formatRelativeTime, normalizeNewlines } from "@/lib/utils";
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

/**
 * Best-effort human-readable preview of a session log row. Skips raw JSON
 * blobs (tool_use / tool_result envelopes etc.) so card body lines stay
 * readable rather than dumping `{"type":"user","message":...}` strings.
 *
 * Returns `null` when no preview is appropriate.
 */
function summarizeLog(log: SessionLog): string | null {
  const firstLine = log.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return null;
  // Skip JSON envelopes — only render plain prose lines on the card.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  if (trimmed.includes("tool_use_id") || trimmed.includes("tool_result")) return null;
  return trimmed.slice(0, 120);
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
      .slice(-4)
      .map(summarizeLog)
      .filter((s): s is string => s !== null && s.length > 0)
      .slice(-2);
  }, [cachedLogs]);

  return (
    <>
      <Card
        data-slot="session-task-card"
        className={cn(
          "transition-colors py-3 gap-2",
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
                  Session start
                </Badge>
              ) : null}
              <p className="text-sm font-medium truncate min-w-0">{task.task}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <StatusBadge status={task.status} />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setOpen(true)}
                className="h-7 w-7"
                title="Open task details"
                aria-label="Open task details"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </div>
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

          <TaskOutcomePreview task={task} fallbackLines={summaryLines} />
        </CardContent>
      </Card>

      <TaskDetailSheet taskId={task.id} task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Preview block shown below the meta row of a task card. Picks the most
 * informative thing we have to show:
 *   1. failed/cancelled + failureReason → red-tinted snippet
 *   2. completed + output → success snippet (clipped to ~200 chars)
 *   3. running with cached log lines → first 1-2 plain-prose log lines
 *      (JSON tool envelopes are skipped — see `summarizeLog`)
 */
function OutcomeBlock({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: "error" | "neutral";
}) {
  const { copied, copy } = useCopyToClipboard();
  const trimmed = text.trim();
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 mt-1 min-w-0 relative group",
        tone === "error" ? "border-status-error/30 bg-status-error/5" : "border-border bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <p
          className={cn(
            "text-[10px] uppercase tracking-wider font-mono",
            tone === "error" ? "text-status-error-strong" : "text-muted-foreground",
          )}
        >
          {label}
        </p>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => copy(trimmed)}
          className="h-6 w-6 -mr-1 opacity-60 hover:opacity-100"
          title={copied ? "Copied" : "Copy output"}
          aria-label={copied ? "Copied" : "Copy output to clipboard"}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
      <div
        className={cn(
          "text-xs min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full",
          tone === "error" ? "text-status-error-strong" : "text-foreground",
        )}
      >
        <Streamdown>{normalizeNewlines(trimmed)}</Streamdown>
      </div>
    </div>
  );
}

function TaskOutcomePreview({ task, fallbackLines }: { task: AgentTask; fallbackLines: string[] }) {
  if (
    (task.status === "failed" || task.status === "cancelled") &&
    task.failureReason &&
    task.failureReason.trim().length > 0
  ) {
    return (
      <OutcomeBlock
        label={task.status === "cancelled" ? "Cancelled" : "Failure"}
        text={task.failureReason}
        tone="error"
      />
    );
  }
  if (task.status === "completed" && task.output && task.output.trim().length > 0) {
    return <OutcomeBlock label="Output" text={task.output} tone="neutral" />;
  }
  if (fallbackLines.length === 0) return null;
  return (
    <ul className="text-xs text-muted-foreground space-y-0.5 mt-0.5">
      {fallbackLines.map((line, idx) => (
        <li key={idx} className="truncate">
          {line}
        </li>
      ))}
    </ul>
  );
}

export interface ParallelGroupProps {
  count: number;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wrapper for siblings sharing a `parentTaskId`. Collapsible — header click
 * toggles. Default expanded for 2-3 children, default collapsed for 4+
 * (otherwise large parallel groups bury the rest of the timeline).
 */
export function ParallelGroup({ count, children, className }: ParallelGroupProps) {
  const [expanded, setExpanded] = useState<boolean>(count <= 3);
  return (
    <div
      data-slot="session-parallel-group"
      className={cn("border border-border bg-muted/30 rounded-md overflow-hidden", className)}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40 hover:bg-muted/60 transition-colors text-left"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} parallel group of ${count} tasks`}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-mono font-medium">
          parallel · {count} tasks
        </span>
      </button>
      {expanded ? <div className="flex flex-col divide-y divide-border">{children}</div> : null}
    </div>
  );
}
