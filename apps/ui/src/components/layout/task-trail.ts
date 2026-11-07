// The task breadcrumb's ancestors: the path from the lineage rows, and the
// rule that folds a long path into "…".
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentTask, TaskLineageResponse } from "../../api/types";

/** Ancestor crumbs the trail shows before the middle folds into "…". */
export const MAX_ANCESTOR_CRUMBS = 3;

export interface TaskPath {
  /** Root first, the parent last. Empty for a root task. */
  ancestors: AgentTask[];
  /** The task's own lineage row. */
  task: AgentTask;
  /**
   * The session root: the top of the path. Null when a server cap cut the
   * walk before the root, so the top row still has a parent.
   */
  sessionRoot: AgentTask | null;
}

/**
 * Walks `parentTaskId` up from `taskId` through the lineage rows. Stops at a
 * row whose parent is missing, and at a cycle. Null when the task itself is
 * not in the rows.
 */
export function taskPathFrom(data: TaskLineageResponse, taskId: string): TaskPath | null {
  const byId = new Map(data.tasks.map((row) => [row.id, row]));
  const task = byId.get(taskId);
  if (!task) return null;
  const path = [task];
  const seen = new Set([task.id]);
  for (let parentId = task.parentTaskId; parentId && !seen.has(parentId); ) {
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentTaskId;
  }
  const top = path[0]!;
  return {
    ancestors: path.slice(0, -1),
    task,
    sessionRoot: top.parentTaskId ? null : top,
  };
}

export interface CollapsedAncestors<T> {
  /** Shown before "…": the root, or nothing. */
  head: T[];
  /** Behind "…". Empty means no "…". */
  hidden: T[];
  /** Shown after "…": the parent, or nothing. */
  tail: T[];
}

/**
 * Which ancestors show and which fold into "…", for at most `max` shown. A
 * path that fits shows whole. A longer one keeps its ends: the root and the
 * parent at `max` 2 or more, the parent alone at 1, nothing at 0.
 */
export function collapseAncestors<T>(ancestors: readonly T[], max: number): CollapsedAncestors<T> {
  if (ancestors.length <= max) return { head: [...ancestors], hidden: [], tail: [] };
  if (max <= 0) return { head: [], hidden: [...ancestors], tail: [] };
  const tail = ancestors.slice(-1);
  if (max === 1) return { head: [], hidden: ancestors.slice(0, -1), tail };
  return { head: ancestors.slice(0, 1), hidden: ancestors.slice(1, -1), tail };
}
