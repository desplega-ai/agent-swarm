export const TASK_FAILURE_CLASSES = [
  "credential_missing",
  "no_agent",
  "no_capable_agent",
  "session_crash",
  "stale_heartbeat",
  "agent_reported",
  "cancelled",
  "unknown",
] as const;

export type TaskFailureClass = (typeof TASK_FAILURE_CLASSES)[number];

/**
 * Reduce a human-readable failure reason to a bounded, anonymous telemetry value.
 * Callers that know the cause should pass an explicit class to `failTask`; this
 * classifier is the compatibility path for the many existing two-argument calls.
 */
export function classifyTaskFailureReason(reason: string | null | undefined): TaskFailureClass {
  const normalized = reason?.trim().toLowerCase();
  if (!normalized || normalized === "unknown failure") return "unknown";

  if (
    normalized.includes("credential missing") ||
    normalized.includes("missing credential") ||
    (normalized.includes("missing") && normalized.includes("llm credential"))
  ) {
    return "credential_missing";
  }
  if (
    normalized.includes("no capable agent") ||
    normalized.includes("no eligible agent") ||
    normalized.includes("no registered agent matches")
  ) {
    return "no_capable_agent";
  }
  if (
    normalized.includes("no agents online") ||
    normalized.includes("no agent online") ||
    normalized.includes("eligible to claim this task are online") ||
    normalized.includes("no available agent") ||
    normalized.includes("assigned agent has not claimed")
  ) {
    return "no_agent";
  }
  if (normalized.includes("stale heartbeat") || normalized.includes("heartbeat is stale")) {
    return "stale_heartbeat";
  }
  if (
    normalized.includes("worker session not found") ||
    normalized.includes("reboot sweep") ||
    normalized.includes("resume_budget_exhausted") ||
    normalized.includes("resume_creation_skipped") ||
    normalized === "superseded_workflow_task" ||
    normalized.includes("process exited without explicit completion") ||
    normalized.includes("subprocess exited") ||
    normalized.includes("session did not settle") ||
    normalized.includes("out of memory")
  ) {
    return "session_crash";
  }
  if (
    normalized.includes("cancel") ||
    normalized.includes("unassigned from") ||
    normalized.includes("review request removed") ||
    normalized === "issue was closed" ||
    normalized === "mr was closed" ||
    normalized === "mr was merged"
  ) {
    return "cancelled";
  }

  return "agent_reported";
}
