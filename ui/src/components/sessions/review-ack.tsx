/**
 * Sessions surface — single muted acknowledgment line shown beneath a
 * worker's row when the orchestrator auto-spawned one or more
 * "Worker task completed — review needed." follow-ups against it.
 *
 * The review row itself is hidden from the timeline (operational, not
 * conversational); this chip preserves the breadcrumb
 * "✓ Reviewed by Lead · 25m ago" with a click affordance to open the
 * underlying task in the side sheet for power users.
 *
 * If the system spawned multiple reviews against the same worker
 * (retries, multi-stage workflows), they collapse into a single chip
 * with a count.
 */

import { Check } from "lucide-react";
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import type { AgentTask } from "@/api/types";
import { cn, formatRelativeTime } from "@/lib/utils";
import { TaskDetailSheet } from "./task-detail-sheet";

export function ReviewAck({ reviews, className }: { reviews: AgentTask[]; className?: string }) {
  // Most recent review carries the "final" prose — that's the entry point.
  const lastReview = reviews[reviews.length - 1];
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
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "self-start inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/70",
          "hover:text-foreground transition-colors",
          className,
        )}
        aria-label={`Open review by ${reviewerName}`}
        title={`Open review by ${reviewerName}`}
      >
        <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          Reviewed by <span className="font-medium text-foreground/80">{reviewerName}</span>
          {reviews.length > 1 ? <span> · {reviews.length} reviews</span> : null}
          <span className="text-muted-foreground/60"> · {formatRelativeTime(finishedAt)}</span>
        </span>
      </button>
      <TaskDetailSheet
        taskId={lastReview.id}
        task={lastReview}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
