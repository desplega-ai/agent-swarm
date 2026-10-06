import type { AgentLog } from "@/api/types";
import { statusLabel } from "./status-labels";

/**
 * Tone of a task event. Status changes take the tone of the status badge
 * (`TaskStatusIcon`), so `cancelled` is neutral here as it is on the badge.
 */
type TaskEventTone =
  | "success"
  | "error"
  | "active"
  | "pending"
  | "paused"
  | "warning"
  | "neutral"
  | "muted";

interface TaskEventDescription {
  /** Sentence-case words, such as "Started by Lead". Never a raw status value. */
  label: string;
  /** A second line for events the dashboard has no words for. */
  detail?: string;
  tone: TaskEventTone;
}

/** Label color per tone (the `-strong` text stops). */
export const TASK_EVENT_TEXT: Record<TaskEventTone, string> = {
  success: "text-status-success-strong",
  error: "text-status-error-strong",
  active: "text-status-active-strong",
  pending: "text-status-pending-strong",
  paused: "text-status-paused-strong",
  warning: "text-status-warning-strong",
  neutral: "text-status-neutral-strong",
  muted: "text-muted-foreground",
};

/** Timeline dot color per tone (the canonical fill stops). */
export const TASK_EVENT_DOT: Record<TaskEventTone, string> = {
  success: "bg-status-success",
  error: "bg-status-error",
  active: "bg-status-active",
  pending: "bg-status-pending",
  paused: "bg-status-paused",
  warning: "bg-status-warning",
  neutral: "bg-status-neutral",
  muted: "bg-muted-foreground/40",
};

/** Tone per task status, the same as the status badge draws it. */
export const TASK_STATUS_TONE: Record<string, TaskEventTone> = {
  draft: "active",
  backlog: "neutral",
  unassigned: "neutral",
  offered: "active",
  reviewing: "paused",
  pending: "neutral",
  in_progress: "active",
  paused: "paused",
  completed: "success",
  failed: "error",
  cancelled: "neutral",
  superseded: "neutral",
};

function statusTone(status: string): TaskEventTone {
  return TASK_STATUS_TONE[status] ?? "muted";
}

function describeStatusChange(
  from: string | undefined,
  to: string | undefined,
  agentName: string | undefined,
): TaskEventDescription {
  if (!to) return { label: "Status changed", tone: "muted" };
  const tone = statusTone(to);
  switch (to) {
    case "in_progress":
      return {
        label: from === "paused" ? "Resumed" : agentName ? `Started by ${agentName}` : "Started",
        tone,
      };
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
    case "paused":
      return { label: statusLabel(to), tone };
    case "reviewing":
      return {
        label: agentName ? `${agentName} is reviewing the offer` : "Reviewing the offer",
        tone,
      };
    default:
      break;
  }
  // `draft` is the "attachments still uploading" state.
  if (from === "draft") return { label: "Attachments uploaded", tone };
  if (to === "pending" && from === "unassigned") {
    return { label: agentName ? `Assigned to ${agentName}` : "Assigned", tone };
  }
  if (to === "pending" && from === "in_progress") return { label: "Back in the queue", tone };
  if (to === "backlog") return { label: "Moved to the backlog", tone };
  if (to === "unassigned") return { label: "Moved to the pool", tone };
  return { label: `Moved to ${statusLabel(to).toLowerCase()}`, tone };
}

/**
 * One task event (`task.logs`) in words, for the Activity list. `agentName`
 * is the agent the event is about: the assignee for status changes, the
 * target for an offer, the creator for `task_created`.
 */
export function describeTaskEvent(
  log: Pick<AgentLog, "eventType" | "oldValue" | "newValue">,
  agentName?: string | null,
): TaskEventDescription {
  const name = agentName?.trim() || undefined;
  switch (log.eventType) {
    case "task_created":
      return { label: name ? `Created by ${name}` : "Created", tone: "neutral" };
    case "task_offered":
      return { label: name ? `Offered to ${name}` : "Offered to an agent", tone: "active" };
    case "task_accepted":
      return { label: name ? `Accepted by ${name}` : "Accepted", tone: "success" };
    case "task_rejected":
      return { label: name ? `Rejected by ${name}` : "Rejected", tone: "error" };
    case "task_claimed":
      return { label: name ? `Claimed by ${name}` : "Claimed", tone: "active" };
    case "task_released":
      return { label: "Released to the pool", tone: "neutral" };
    case "task_progress": {
      const text = log.newValue?.trim();
      return { label: text ? `Progress: ${text}` : "Progress update", tone: "muted" };
    }
    case "task_status_change":
      return describeStatusChange(log.oldValue, log.newValue, name);
    default: {
      // Events the dashboard has no words for yet (the API sends more types
      // than `AgentLogEventType` lists): name the event, keep the value.
      const words = String(log.eventType)
        .replace(/^task_/, "")
        .replace(/_/g, " ");
      const value = log.newValue?.trim();
      return {
        label: words.charAt(0).toUpperCase() + words.slice(1),
        detail: value ? (TASK_STATUS_TONE[value] ? statusLabel(value) : value) : undefined,
        tone: "muted",
      };
    }
  }
}
