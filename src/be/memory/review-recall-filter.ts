/**
 * Review tasks stop recalling other review tasks' `task_completion` memories.
 *
 * A review task's completion memory only echoes the shared review brief, so a
 * later review task recalls boilerplate instead of anything about its own diff.
 * The rule uses task fields only, never the prompt text:
 *
 *   a task is a review task when `taskType === "review"` or its tags include
 *   `re-review` (re-review and rereview-sweep tasks) or `pr-review-demo`
 *   (the batch-review workflow).
 *
 * When the recalling task is a review task, a candidate is dropped when its
 * `source` is `task_completion` and its `sourceTaskId` is also a review task.
 * Other memory sources, and non-review recallers, are untouched. A source task
 * that no longer exists is kept: its kind is unknown.
 */

import type { AgentMemory } from "@/types";
import { getDbClient, getTaskById } from "../db";

export const REVIEW_TASK_TYPE = "review";
export const REVIEW_TASK_TAGS: readonly string[] = ["re-review", "pr-review-demo"];

export function isReviewTask(task: { taskType?: string | null; tags?: readonly string[] | null }) {
  return (
    task.taskType === REVIEW_TASK_TYPE ||
    (task.tags ?? []).some((t) => REVIEW_TASK_TAGS.includes(t))
  );
}

function parseTags(raw: string | null): string[] {
  try {
    const tags = JSON.parse(raw ?? "[]");
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** True when `taskId` names a review task. Unknown or missing ids are not review tasks. */
export async function isReviewTaskId(taskId: string | undefined | null): Promise<boolean> {
  if (!taskId) return false;
  const task = await getTaskById(taskId);
  return task ? isReviewTask(task) : false;
}

// Stay well under SQLite's bound-variable limit.
const ID_CHUNK = 500;

/** Drop review-sourced `task_completion` rows. Call only when the recaller is a review task. */
export async function dropReviewTaskCompletions<T extends AgentMemory>(
  candidates: T[],
): Promise<T[]> {
  const sourceIds = [
    ...new Set(
      candidates
        .filter((c) => c.source === "task_completion" && c.sourceTaskId)
        .map((c) => c.sourceTaskId as string),
    ),
  ];
  if (sourceIds.length === 0) return candidates;

  const reviewIds = new Set<string>();
  for (let i = 0; i < sourceIds.length; i += ID_CHUNK) {
    const chunk = sourceIds.slice(i, i + ID_CHUNK);
    const rows = await getDbClient().query<{
      id: string;
      taskType: string | null;
      tags: string | null;
    }>(
      `SELECT id, taskType, tags FROM agent_tasks WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const row of rows) {
      if (isReviewTask({ taskType: row.taskType, tags: parseTags(row.tags) }))
        reviewIds.add(row.id);
    }
  }
  if (reviewIds.size === 0) return candidates;
  return candidates.filter(
    (c) => !(c.source === "task_completion" && c.sourceTaskId && reviewIds.has(c.sourceTaskId)),
  );
}
