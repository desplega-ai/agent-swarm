/**
 * Steering — shared presentation pieces for a single steering message.
 *
 * Steering messages are user intent injected into an already-running task.
 * They surface in three places, and all three compose from here so the chip
 * and the body treatment can't drift:
 *
 *   1. Task detail → interleaved into the SESSION LOGS stream, positioned by
 *      `deliveredAt` — the moment the message actually entered the session.
 *   2. Task detail → the pinned "queued steering" bar at the tail of the log
 *      stream, for messages that are still `pending`.
 *   3. Sessions timeline → one row inside a task's `<ChainOfThought>` activity
 *      feed, positioned by `createdAt`.
 *
 * Density is the constraint: every one of those lists is made of single-line
 * rows, so `<SteeringLine>` is single-line too — marker, one combined
 * `mode · status` chip, the body truncated inline, and whatever timestamp the
 * host list already renders. The full body is one click (or one hover) away,
 * never a permanently expanded block.
 *
 * Status moves `pending → delivered → handled`, or terminates at `promoted`
 * (became a follow-up task) / `cancelled`. It updates off the 5s REST poll in
 * `useTaskSteeringMessages` — there is no websocket/SSE channel.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import type { SteeringMessage, SteeringStatus } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, formatSmartTime } from "@/lib/utils";

/** Status-token classes per lifecycle state (no raw palette literals — lint gate). */
export const STEERING_STATUS_CLASS: Record<SteeringStatus, string> = {
  pending: "border-status-pending/30 text-status-pending-strong",
  delivered: "border-status-info/30 text-status-info-strong",
  handled: "border-status-success/30 text-status-success-strong",
  promoted: "border-status-paused/30 text-status-paused-strong",
  cancelled: "border-status-neutral/30 text-muted-foreground",
};

const STEERING_STATUS_HINT: Record<SteeringStatus, string> = {
  pending: "Waiting for the worker to pick it up.",
  delivered: "Handed to the harness — the agent hasn't acknowledged it yet.",
  handled: "The agent acknowledged handling this message.",
  promoted: "Couldn't be delivered live, so it became a follow-up task.",
  cancelled: "Cancelled before delivery.",
};

/**
 * The timestamp a message should be sorted / displayed by.
 *
 * `delivered` / `handled` rows belong where they entered the session
 * (`deliveredAt`), not where the user typed them — that's what makes the
 * interleaved log stream read correctly. Everything else falls back to
 * `createdAt`.
 */
export function steeringMessageTimestamp(message: SteeringMessage): string {
  if (message.status === "delivered" || message.status === "handled") {
    return message.deliveredAt ?? message.createdAt;
  }
  return message.createdAt;
}

/**
 * The lifecycle moment the chip's tooltip should date-stamp: the most recent
 * transition we actually have a timestamp for.
 */
function statusTimestampLine(message: SteeringMessage): string {
  if (message.status === "handled" && message.handledAt) {
    return `Handled ${formatSmartTime(message.handledAt)}`;
  }
  if ((message.status === "handled" || message.status === "delivered") && message.deliveredAt) {
    return `Delivered ${formatSmartTime(message.deliveredAt)}`;
  }
  if (message.status === "pending") return `Queued ${formatSmartTime(message.createdAt)}`;
  return `Sent ${formatSmartTime(message.createdAt)}`;
}

export interface SteeringChipProps {
  message: SteeringMessage;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}

/**
 * One combined `queue · handled` chip. Two separate chips (mode + status) cost
 * horizontal room in these dense lists for no extra information, so they're
 * merged and the nuance moves into the tooltip: the status hint, the degrade
 * note when the harness downgraded the mode, the transition timestamp, and —
 * for `handled` — the agent's own note on how it incorporated the steering.
 */
export function SteeringChip({ message, side = "top", className }: SteeringChipProps) {
  const modeLabel = message.mode === "steer" ? "interrupt" : "queue";
  const degraded = message.deliveredMode && message.deliveredMode !== message.mode;
  const note = message.status === "handled" ? message.handledNote?.trim() : undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          size="tag"
          className={cn("shrink-0 cursor-help", STEERING_STATUS_CLASS[message.status], className)}
        >
          {modeLabel} · {message.status}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs">
        <span className="block">{STEERING_STATUS_HINT[message.status]}</span>
        {degraded ? (
          <span className="block opacity-80">Delivered as {message.deliveredMode}.</span>
        ) : null}
        <span className="block opacity-80">{statusTimestampLine(message)}</span>
        {note ? <span className="mt-1 block italic">“{note}”</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export interface SteeringLineProps {
  message: SteeringMessage;
  /**
   * Leading marker — the sessions activity feed passes an icon, the session-log
   * stream passes a "STEERING" text marker styled like its SYSTEM marker.
   */
  marker?: React.ReactNode;
  /** Trailing node (usually the host list's own right-aligned timestamp). */
  trailing?: React.ReactNode;
  className?: string;
}

/**
 * Single-line steering row. The body collapses whitespace and truncates; when
 * there is more to see it becomes a button — hover for the full text, click to
 * expand it in place.
 */
export function SteeringLine({ message, marker, trailing, className }: SteeringLineProps) {
  const [expanded, setExpanded] = useState(false);
  const oneLine = message.body.replace(/\s+/g, " ").trim();
  // Cheap "there's more to see" heuristic — collapsed whitespace means the
  // rendered line already differs from the source, and long single lines get
  // clipped by `truncate` regardless of container width.
  const hasMore = oneLine.length > 72 || oneLine !== message.body.trim();

  const body = (
    <span
      className={cn(
        "min-w-0 flex-1 text-foreground/90",
        expanded ? "whitespace-pre-wrap break-words" : "truncate",
      )}
    >
      {expanded ? message.body : oneLine}
    </span>
  );

  return (
    <div
      data-slot="steering-line"
      className={cn("flex min-w-0 gap-2", expanded ? "items-start" : "items-center", className)}
    >
      {marker}
      <SteeringChip message={message} />
      {hasMore ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 cursor-pointer text-left hover:text-foreground"
            >
              {body}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-md whitespace-pre-wrap">
            {message.body}
          </TooltipContent>
        </Tooltip>
      ) : (
        body
      )}
      {message.promotedTaskId ? (
        <Link
          to={`/tasks/${message.promotedTaskId}`}
          className="shrink-0 font-mono text-[10px] text-primary hover:underline"
        >
          → #{message.promotedTaskId.slice(0, 8)}
        </Link>
      ) : null}
      {trailing}
    </div>
  );
}
