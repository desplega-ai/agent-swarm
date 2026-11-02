// Relative imports only: `bun:test` runs this from the repo root.
import type { AgentTask } from "../api/types";

/**
 * The task a delegation shows under: the task whose session dispatched it
 * (`dispatchedByTaskId`), when that task is loaded. Otherwise its
 * `parentTaskId`: rows from before the column, tasks no send-task created,
 * and dispatchers outside the loaded chain. `parentTaskId` alone can point at
 * an earlier worker task, for context continuity, instead of the lead turn
 * that sent the work.
 */
export function dispatchParentId(
  task: Pick<AgentTask, "id" | "parentTaskId" | "dispatchedByTaskId">,
  isLoaded: (id: string) => boolean,
): string | undefined {
  const by = task.dispatchedByTaskId;
  return by && by !== task.id && isLoaded(by) ? by : task.parentTaskId;
}
