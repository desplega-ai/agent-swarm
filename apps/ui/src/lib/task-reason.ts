import type { AgentTask } from "@/api/types";

export type TaskReason = {
  label: "Failure" | "Cancelled" | "Skipped";
  text: string;
  tone: "error" | "neutral";
};

/**
 * Why a task ended without an answer: the `failureReason` of a failed,
 * cancelled or skipped task. A skip is a decision, not an error, so it reads
 * in the neutral tone. Null for any other status or a blank reason.
 */
export function taskReason(task: Pick<AgentTask, "status" | "failureReason">): TaskReason | null {
  const text = task.failureReason?.trim();
  if (!text) return null;
  switch (task.status) {
    case "failed":
      return { label: "Failure", text, tone: "error" };
    case "cancelled":
      return { label: "Cancelled", text, tone: "error" };
    case "skipped":
      return { label: "Skipped", text, tone: "neutral" };
    default:
      return null;
  }
}
