// Relative imports only: `bun:test` runs this from the repo root.
import type { AgentTask } from "../api/types";

/** The task whose session dispatched `task`, as send-task recorded it. */
export function recordedDispatcherId(
  task: Pick<AgentTask, "id" | "dispatchedByTaskId">,
): string | undefined {
  const by = task.dispatchedByTaskId;
  return by && by !== task.id ? by : undefined;
}

/**
 * The task a delegation shows under in a session tree: the task whose session
 * dispatched it (`dispatchedByTaskId`), when that task is loaded. Otherwise
 * its `parentTaskId`: rows from before the column, tasks no send-task
 * created, and dispatchers outside the loaded session, so the task still has
 * a place in the tree. `parentTaskId` alone can point at an earlier worker
 * task, for context continuity, instead of the lead turn that sent the work.
 */
export function dispatchParentId(
  task: Pick<AgentTask, "id" | "parentTaskId" | "dispatchedByTaskId">,
  isLoaded: (id: string) => boolean,
): string | undefined {
  const by = recordedDispatcherId(task);
  return by && isLoaded(by) ? by : task.parentTaskId;
}
