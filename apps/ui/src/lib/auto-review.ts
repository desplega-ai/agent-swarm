import type { AgentTask } from "@/api/types";

/**
 * `true` for the orchestrator's auto-spawned review follow-ups ("Worker task
 * completed, review needed." rows). Identified by the wire fields, not by the
 * task text. The Sessions timeline folds them into a chip, and the task page
 * leaves them out of its spawned tasks.
 */
export function isAutoReview(task: Pick<AgentTask, "source" | "taskType">): boolean {
  return task.source === "system" && task.taskType === "follow-up";
}
