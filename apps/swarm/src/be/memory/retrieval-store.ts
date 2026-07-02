/**
 * Read-side query helpers for the `memory_retrieval` audit log.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-3.md
 *
 * Step-2 owns the write path (`searchMemory` populates `memory_retrieval`
 * when `X-Source-Task-ID` is set). Step-3 surfaces these reads to:
 *   - GET /api/memory/retrievals — worker raters list memories surfaced for
 *     a task/session so they can score them.
 *   - POST /api/memory/rate — R6 spam-guard checks that an `explicit-self`
 *     rating targets a memory that was actually retrieved for the task.
 *
 * Server-side only. Route handlers should call these functions instead of
 * preparing SQL directly so the query is reusable and typed in one place.
 */
import { getDb } from "@/be/db";

/** Max chars of `agent_memory.content` returned in retrieval listings. */
const RETRIEVAL_CONTENT_SNIPPET_CHARS = 500;

/** Max retrievals returned per request — matches the typical session set. */
const RETRIEVAL_LIST_LIMIT = 50;

export type RetrievalListRow = {
  /** `agent_memory.id` — the memory that was retrieved. */
  id: string;
  name: string;
  /** Up to RETRIEVAL_CONTENT_SNIPPET_CHARS chars of `agent_memory.content`. */
  content: string;
  scope: string;
  /**
   * `agent_memory.source` — `'task_completion' | 'session_summary' | 'manual'
   * | 'file_index'`. Surfaced so the worker rater can scope dedup to the
   * memory class that exhibits scheduled-task self-similarity.
   */
  source: string;
  /**
   * `agent_tasks.scheduleId` for the source task that wrote this memory, or
   * `null` if the memory has no source task or the task wasn't a scheduled
   * run. Worker raters use this as a precise cron-clone discriminator —
   * memories sharing a non-null `scheduleId` are by definition from the same
   * scheduled job and safe to dedupe.
   */
  scheduleId: string | null;
  similarity: number | null;
  retrievalSource: string | null;
  retrievedAt: string;
};

export type RetrievalListFilter = {
  taskId?: string;
  sessionId?: string;
};

/**
 * List memories retrieved for a given (taskId | sessionId), filtered by the
 * requesting agent for defence-in-depth (the JOIN on `mr.agentId` keeps
 * cross-agent rows out even though the worker is trusted).
 *
 * Returns at most {@link RETRIEVAL_LIST_LIMIT} rows, newest-first by
 * `retrievedAt`. Caller MUST pass at least one of `taskId` / `sessionId`;
 * the route's Zod schema enforces this — this function does not re-validate.
 */
export function getRetrievalsForAgent(
  agentId: string,
  filter: RetrievalListFilter,
): RetrievalListRow[] {
  const conditions: string[] = ["mr.agentId = ?"];
  const params: (string | number)[] = [agentId];
  if (filter.taskId) {
    conditions.push("mr.taskId = ?");
    params.push(filter.taskId);
  }
  if (filter.sessionId) {
    conditions.push("mr.sessionId = ?");
    params.push(filter.sessionId);
  }

  // LEFT JOIN agent_tasks so we can surface `scheduleId` to worker raters —
  // a non-null `scheduleId` is the precise cron-clone discriminator that
  // `dedupeRetrievalsForRater` keys on. The LEFT keeps memories with no
  // source task (manual / file_index) in the result set.
  const sql = `
    SELECT am.id        AS id,
           am.name      AS name,
           substr(am.content, 1, ?) AS content,
           am.scope     AS scope,
           am.source    AS source,
           at.scheduleId AS scheduleId,
           mr.similarity AS similarity,
           mr.retrievalSource AS retrievalSource,
           mr.retrievedAt AS retrievedAt
      FROM memory_retrieval mr
      INNER JOIN agent_memory am ON am.id = mr.memoryId
      LEFT JOIN  agent_tasks at  ON at.id = am.sourceTaskId
     WHERE ${conditions.join(" AND ")}
     ORDER BY mr.retrievedAt DESC
     LIMIT ?
  `;

  return getDb()
    .prepare<RetrievalListRow, (string | number)[]>(sql)
    .all(RETRIEVAL_CONTENT_SNIPPET_CHARS, ...params, RETRIEVAL_LIST_LIMIT);
}

/**
 * R6 spam-guard read: was the given `(taskId, memoryId)` actually surfaced
 * to the agent during the task? Used by the rate endpoint to reject
 * `explicit-self` ratings for memories the agent never saw.
 */
export function hasRetrievalForTask(taskId: string, memoryId: string): boolean {
  const row = getDb()
    .prepare<{ id: string }, [string, string]>(
      "SELECT id FROM memory_retrieval WHERE taskId = ? AND memoryId = ? LIMIT 1",
    )
    .get(taskId, memoryId);
  return row != null;
}
