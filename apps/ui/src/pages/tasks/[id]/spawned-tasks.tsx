import type { AgentTask } from "@/api/types";
import { isAutoReview } from "@/lib/auto-review";

/** The tasks `parentId` started directly, oldest first, without auto-review follow-ups. */
export function directChildren(parentId: string, chain: readonly AgentTask[]): AgentTask[] {
  return chain
    .filter((task) => task.parentTaskId === parentId && !isAutoReview(task))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
