/**
 * Chain-of-thought indicator — inline activity feed for an agent turn.
 *
 * Pulls the canonical `AgentLog[]` activity stream via `useTask(id)` (the
 * same data source the task-detail page renders in its right rail under
 * "Activity"). Each step renders as one short prose line, with the
 * latest line shimmering while the task is still running.
 *
 * Visible states:
 *   - active (`pending` / `offered` / `in_progress`): always rendered, last
 *     line shimmers. While the task is active the underlying `useTask`
 *     query polls every 4 s so new events flow into the list live.
 *   - terminal (`completed` / `failed` / `cancelled`): collapsible. Collapsed
 *     by default with a quiet "Activity (N steps)" header that expands on
 *     click — the user gets the ability to keep the breadcrumb without it
 *     dominating the timeline.
 */

import { Check, ChevronDown, ChevronRight, CircleDot, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useTask } from "@/api/hooks/use-tasks";
import type { AgentLog, AgentTaskStatus } from "@/api/types";
import { cn, formatRelativeTime } from "@/lib/utils";

const ACTIVE_STATUSES = new Set<AgentTaskStatus>([
  "pending",
  "offered",
  "backlog",
  "unassigned",
  "in_progress",
  "paused",
  "reviewing",
]);

function summarizeAgentLog(log: AgentLog): string | null {
  switch (log.eventType) {
    case "task_created":
      return "Created";
    case "task_offered":
      return "Offered to agent";
    case "task_accepted":
      return "Accepted";
    case "task_rejected":
      return "Rejected";
    case "task_claimed":
      return "Claimed";
    case "task_released":
      return "Released";
    case "task_status_change": {
      const old = log.oldValue ?? "";
      const next = log.newValue ?? "";
      if (!next) return null;
      if (old) return `${old} → ${next}`;
      return next;
    }
    case "task_progress": {
      const v = log.newValue?.trim();
      if (!v) return "Progress update";
      // Skip JSON envelopes — only show plain prose progress notes.
      if (v.startsWith("{") || v.startsWith("[")) return null;
      return v.length > 140 ? `${v.slice(0, 140)}…` : v;
    }
    case "channel_message":
    case "agent_joined":
    case "agent_left":
    case "agent_status_change":
      // Not interesting at the per-task level.
      return null;
    default:
      return null;
  }
}

interface Step {
  id: string;
  text: string;
  createdAt: string;
}

export interface ChainOfThoughtProps {
  taskId: string;
  status: AgentTaskStatus;
  className?: string;
}

export function ChainOfThought({ taskId, status, className }: ChainOfThoughtProps) {
  const isActive = ACTIVE_STATUSES.has(status);
  // Poll while the task is active so new activity rows flow in. Stop polling
  // once the task reaches a terminal state.
  const { data: task } = useTask(taskId, { refetchInterval: isActive ? 4000 : false });

  const steps = useMemo<Step[]>(() => {
    const logs = task?.logs ?? [];
    const out: Step[] = [];
    for (const log of logs) {
      const text = summarizeAgentLog(log);
      if (!text) continue;
      out.push({ id: log.id, text, createdAt: log.createdAt });
    }
    return out;
  }, [task?.logs]);

  const [expanded, setExpanded] = useState(false);

  // Active task with no events yet — show a shimmering placeholder so the row
  // never reads as silent immediately after the user sends.
  if (steps.length === 0) {
    if (!isActive) return null;
    return (
      <div className={cn("flex items-center gap-2 text-xs", className)} aria-live="polite">
        <CircleDot className="h-3 w-3 text-primary shrink-0" aria-hidden="true" />
        <span className="shimmer-text">
          {status === "in_progress" ? "Thinking…" : "Waiting for an agent to pick this up…"}
        </span>
      </div>
    );
  }

  // Terminal state — collapsible. Collapsed shows just a single muted line
  // with the count + the last step text.
  if (!isActive && !expanded) {
    const last = steps[steps.length - 1];
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(
          "group flex items-center gap-1.5 text-[11px] text-muted-foreground/80 hover:text-foreground transition-colors text-left min-w-0",
          className,
        )}
        aria-expanded={false}
        aria-label={`Show ${steps.length} activity steps`}
      >
        <ChevronRight className="h-3 w-3 shrink-0 group-hover:text-foreground" aria-hidden="true" />
        <Sparkles className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
        <span className="font-mono uppercase tracking-wider text-[9px]">
          Activity · {steps.length}
        </span>
        <span aria-hidden="true">·</span>
        <span className="truncate italic">{last?.text}</span>
      </button>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)} aria-live="polite">
      {!isActive ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="group flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors text-left min-w-0 self-start"
          aria-expanded={true}
          aria-label={`Hide ${steps.length} activity steps`}
        >
          <ChevronDown
            className="h-3 w-3 shrink-0 group-hover:text-foreground"
            aria-hidden="true"
          />
          <Sparkles className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>Activity · {steps.length}</span>
        </button>
      ) : null}
      <ol className="flex flex-col gap-1 text-xs" aria-label="Agent reasoning">
        {steps.map((step, idx) => {
          const isLast = idx === steps.length - 1;
          const shimmer = isLast && isActive;
          return (
            <li key={step.id} className="flex items-start gap-2 min-w-0 break-words">
              {shimmer ? (
                <CircleDot
                  className="h-3 w-3 mt-0.5 text-primary shrink-0 animate-pulse"
                  aria-hidden="true"
                />
              ) : (
                <Check
                  className="h-3 w-3 mt-0.5 text-muted-foreground/70 shrink-0"
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  "min-w-0 break-words flex-1",
                  shimmer ? "shimmer-text font-medium" : "text-muted-foreground/85",
                )}
              >
                {step.text}
              </span>
              <span
                className="text-[10px] font-mono text-muted-foreground/60 shrink-0 mt-0.5"
                title={new Date(step.createdAt).toLocaleString()}
              >
                {formatRelativeTime(step.createdAt)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
