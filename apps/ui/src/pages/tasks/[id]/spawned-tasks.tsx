import type { AgentTask } from "@/api/types";

/**
 * The tasks `parentId` started directly, oldest first. The transcript draws
 * each by its kind (`childKind`), the result sent to the lead included.
 */
export function directChildren(parentId: string, chain: readonly AgentTask[]): AgentTask[] {
  return chain
    .filter((task) => task.parentTaskId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
