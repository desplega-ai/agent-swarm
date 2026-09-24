/**
 * Sessions surface — status-aware summary shown beneath a worker's row when
 * the orchestrator auto-spawned one or more "Worker task completed — review
 * needed." follow-ups against it.
 *
 * The review row itself is hidden from the timeline (operational, not
 * conversational — see `isAutoReview` in `session-timeline.tsx`), but the
 * *outcome* of the most recent review is not: this chip mirrors the same
 * live-activity / final-outcome split a normal `<TaskCard>` uses, because a
 * hidden review is frequently where the agent's actual human-facing answer
 * lands (e.g. Lead relaying a completed delegated worker's result). Hiding
 * the row must never also hide the answer or the fact that work is still
 * happening.
 */

import { Ban, Check, SkipForward, X } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import type { AgentTask } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn, formatRelativeTime } from "@/lib/utils";
import { ChainOfThought } from "./chain-of-thought";
import { TaskDetailSheet } from "./task-detail-sheet";
import { TaskOutcome } from "./task-outcome";

/** Same "is long" heuristic as `TaskBrief` in `task-card.tsx`. */
function isLongText(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.length > 240 || text.split("\n").length > 3;
}

function Name({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground/80">{children}</span>;
}

export function ReviewAck({ reviews, className }: { reviews: AgentTask[]; className?: string }) {
  // Most recent review carries the "final" prose — that's the entry point.
  const lastReview = reviews[reviews.length - 1];
  const status = lastReview.status;
  const isActive = !TERMINAL_STATUSES.has(status);
  const isRunning = status === "in_progress";
  const [expanded, setExpanded] = useState(false);
  // Sheet open-state lives in the URL (`?task=<id>`) for shareable links —
  // mirrors TaskCard so a session URL pinning a review is reproducible.
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get("task") === lastReview.id;
  const setOpen = useCallback(
    (next: boolean) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next) sp.set("task", lastReview.id);
          else if (sp.get("task") === lastReview.id) sp.delete("task");
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams, lastReview.id],
  );
  const { data: agent } = useAgent(lastReview.agentId ?? "");
  const reviewerName =
    agent?.name ?? (lastReview.agentId ? `${lastReview.agentId.slice(0, 8)}…` : "agent");
  const finishedAt = lastReview.lastUpdatedAt ?? lastReview.createdAt;
  const outcomeText = status === "completed" ? lastReview.output : lastReview.failureReason;
  const clampable = !isActive && isLongText(outcomeText);
  const suffix = (
    <>
      {reviews.length > 1 ? <span> · {reviews.length} reviews</span> : null}
      <span className="text-muted-foreground/60"> · {formatRelativeTime(finishedAt)}</span>
    </>
  );
  const iconClass = "h-3 w-3 shrink-0 inline -mt-0.5 mr-1";

  let label: ReactNode;
  if (status === "in_progress") {
    label = (
      <>
        <Name>{reviewerName}</Name> is reviewing…
      </>
    );
  } else if (status === "paused") {
    label = (
      <>
        Review by <Name>{reviewerName}</Name> paused
      </>
    );
  } else if (isActive) {
    // pending / offered / unassigned / backlog / draft / reviewing: nobody is working on it yet.
    label = lastReview.agentId ? (
      <>
        Review by <Name>{reviewerName}</Name> queued
      </>
    ) : (
      "Review queued"
    );
  } else if (status === "failed") {
    label = (
      <>
        <X className={cn(iconClass, "text-status-error-strong")} aria-hidden="true" />
        Review by <Name>{reviewerName}</Name> failed{suffix}
      </>
    );
  } else if (status === "cancelled") {
    label = (
      <>
        <Ban className={iconClass} aria-hidden="true" />
        Review by <Name>{reviewerName}</Name> cancelled{suffix}
      </>
    );
  } else if (status === "superseded") {
    label = (
      <>
        <SkipForward className={iconClass} aria-hidden="true" />
        Review by <Name>{reviewerName}</Name> superseded{suffix}
      </>
    );
  } else {
    label = (
      <>
        <Check className={iconClass} aria-hidden="true" />
        Reviewed by <Name>{reviewerName}</Name>
        {suffix}
      </>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1 min-w-0", className)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "self-start inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/70",
          "hover:text-foreground transition-colors",
        )}
        aria-label={`Open review by ${reviewerName}`}
        title={`Open review by ${reviewerName}`}
      >
        <AgentAvatar
          agentId={lastReview.agentId}
          agentName={agent?.name}
          size="xs"
          className={cn(isRunning && "ring-2 ring-primary/40 animate-pulse")}
        />
        <span>{label}</span>
      </button>
      {/* Live progress while the review is active, the outcome inline once it
          lands. Long outcomes clamp so relays don't take over the timeline. */}
      <div className="pl-6 min-w-0">
        {isActive ? (
          <ChainOfThought taskId={lastReview.id} status={status} />
        ) : (
          <>
            <div
              data-slot="review-outcome"
              className={cn(clampable && !expanded && "max-h-24 overflow-hidden")}
            >
              <TaskOutcome task={lastReview} />
            </div>
            {clampable ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-foreground transition-colors mt-1"
                aria-expanded={expanded}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </>
        )}
      </div>
      <TaskDetailSheet
        taskId={lastReview.id}
        task={lastReview}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
