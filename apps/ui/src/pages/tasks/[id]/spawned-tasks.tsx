import type { AgentTask } from "@/api/types";
// Relative: `bun:test` runs this from the repo root.
import { recordedDispatcherId } from "../../../lib/dispatch-parent";

/**
 * The tasks `parentId` started directly, oldest first: the ones it dispatched,
 * also when their `parentTaskId` points at an earlier task for continuity.
 * A recorded dispatcher wins even when the chain does not hold it: the task
 * detail loads only this task's subtree, so a continuation another turn sent
 * comes back without its dispatcher. Rows with no recorded dispatcher fall
 * back to `parentTaskId`. The transcript draws each by its kind
 * (`childKind`), the result sent to the lead included.
 */
export function directChildren(parentId: string, chain: readonly AgentTask[]): AgentTask[] {
  return chain
    .filter((task) => (recordedDispatcherId(task) ?? task.parentTaskId) === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
