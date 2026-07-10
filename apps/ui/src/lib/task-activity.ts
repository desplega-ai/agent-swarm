import type { AgentTaskStatus } from "@/api/types";

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const ACTIVITY_TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  ...TERMINAL_STATUSES,
  "superseded",
]);

const WAITING_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
]);

export const TASK_ACTIVITY_QUIET_AFTER_MS = 5 * 60 * 1000;
export const TASK_ACTIVITY_STUCK_AFTER_MS = 30 * 60 * 1000;
export const TASK_DETAIL_POLL_INTERVAL_MS = 5 * 1000;

export type TaskActivityKind =
  | "active"
  | "quiet"
  | "stuck"
  | "waiting"
  | "paused"
  | "terminal"
  | "unknown";

export type TaskActivityTone =
  | "active"
  | "warning"
  | "pending"
  | "paused"
  | "success"
  | "error"
  | "neutral";

export interface TaskActivityClassification {
  kind: TaskActivityKind;
  label: string;
  tone: TaskActivityTone;
  ageMs: number | null;
  mayBeStuck: boolean;
}

interface TaskActivityTimestamps {
  lastUpdatedAt?: string;
  logs?: ReadonlyArray<{ createdAt: string }>;
}

function parseActivityTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const normalized =
    timestamp.includes("T") || timestamp.endsWith("Z")
      ? timestamp
      : `${timestamp.replace(" ", "T")}Z`;
  const timestampMs = new Date(normalized).getTime();
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function terminalLabel(status: AgentTaskStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll("_", " ")}`;
}

function terminalTone(status: AgentTaskStatus): TaskActivityTone {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "neutral";
}

/**
 * Classify how recently a task produced observable activity.
 *
 * Timestamp validity wins over status: a missing or malformed timestamp is
 * always Unknown and can never produce a stuck warning.
 */
export function classifyTaskActivity(
  status: AgentTaskStatus | undefined,
  lastActivityAt: string | undefined,
  nowMs = Date.now(),
): TaskActivityClassification {
  const lastActivityMs = parseActivityTimestamp(lastActivityAt);
  if (lastActivityMs === null || !Number.isFinite(nowMs)) {
    return {
      kind: "unknown",
      label: "Unknown",
      tone: "neutral",
      ageMs: null,
      mayBeStuck: false,
    };
  }

  const ageMs = Math.max(0, nowMs - lastActivityMs);

  if (!status) {
    return {
      kind: "unknown",
      label: "Unknown",
      tone: "neutral",
      ageMs,
      mayBeStuck: false,
    };
  }

  if (status === "in_progress") {
    if (ageMs < TASK_ACTIVITY_QUIET_AFTER_MS) {
      return {
        kind: "active",
        label: "Active",
        tone: "active",
        ageMs,
        mayBeStuck: false,
      };
    }
    if (ageMs < TASK_ACTIVITY_STUCK_AFTER_MS) {
      return {
        kind: "quiet",
        label: "Quiet",
        tone: "neutral",
        ageMs,
        mayBeStuck: false,
      };
    }
    return {
      kind: "stuck",
      label: "May be stuck",
      tone: "warning",
      ageMs,
      mayBeStuck: true,
    };
  }

  if (WAITING_STATUSES.has(status)) {
    return {
      kind: "waiting",
      label: "Waiting",
      tone: "pending",
      ageMs,
      mayBeStuck: false,
    };
  }

  if (status === "paused") {
    return {
      kind: "paused",
      label: "Paused",
      tone: "paused",
      ageMs,
      mayBeStuck: false,
    };
  }

  if (ACTIVITY_TERMINAL_STATUSES.has(status)) {
    return {
      kind: "terminal",
      label: terminalLabel(status),
      tone: terminalTone(status),
      ageMs,
      mayBeStuck: false,
    };
  }

  return {
    kind: "unknown",
    label: "Unknown",
    tone: "neutral",
    ageMs,
    mayBeStuck: false,
  };
}

/** Detail pages prefer their newest event, then fall back to the task row. */
export function getTaskLastActivityAt(task: TaskActivityTimestamps): string | undefined {
  return task.logs?.[0]?.createdAt ?? task.lastUpdatedAt;
}

/** Keep task detail live until the server returns a terminal lifecycle state. */
export function getTaskDetailPollInterval(status: AgentTaskStatus | undefined): number | false {
  return status && ACTIVITY_TERMINAL_STATUSES.has(status) ? false : TASK_DETAIL_POLL_INTERVAL_MS;
}

export function formatTaskActivityAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";

  const seconds = Math.floor(Math.max(0, ageMs) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Tri-state liveness for a task, used by the session-log viewer footer.
 *
 * - `true`      → actively working (`in_progress`) → "Agent is working…"
 * - `false`     → finished (`completed` / `failed` / `cancelled`) → "Session complete"
 * - `undefined` → indeterminate (queued, paused, reviewing, …) → neutral footer,
 *                 so we never falsely claim a paused/pending task is "complete".
 */
export function taskIsRunning(status: AgentTaskStatus | undefined): boolean | undefined {
  if (!status) return undefined;
  if (status === "in_progress") return true;
  if (TERMINAL_STATUSES.has(status)) return false;
  return undefined;
}
