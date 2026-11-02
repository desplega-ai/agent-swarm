import type { AgentTask } from "@/api/types";
// Relative: `bun:test` runs this from the repo root.
import { dispatchParentId } from "../../../lib/dispatch-parent";

/**
 * The tasks `parentId` started directly, oldest first: the ones it dispatched,
 * also when their `parentTaskId` points at an earlier task for continuity.
 * The transcript draws each by its kind (`childKind`), the result sent to the
 * lead included.
 */
export function directChildren(parentId: string, chain: readonly AgentTask[]): AgentTask[] {
  const loaded = new Set(chain.map((task) => task.id));
  return chain
    .filter((task) => dispatchParentId(task, (id) => loaded.has(id)) === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
