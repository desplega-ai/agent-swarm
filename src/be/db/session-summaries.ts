import { getDbClient } from "./runtime";

/**
 * `session_summaries` and `session_members` (migration 253) store the session
 * chain walk: one row per root with its chain aggregates, and the root of
 * every chain task. Triggers keep them exact on every task, steering and
 * approval write. The one exception is a deleted task's descendants: a
 * trigger body cannot walk the chain, so `deleteTask` calls
 * {@link dropSessionDescendants} before the DELETE.
 */

/**
 * Drop the members rows of a task's descendants. Once the task is gone, the
 * chain walk no longer reaches them, so they belong to no session. Call it in
 * the delete's transaction, before the DELETE; the delete trigger then
 * recomputes the chain's summary.
 */
export async function dropSessionDescendants(taskId: string): Promise<void> {
  // UNION, not UNION ALL: a parentTaskId cycle written before migration 253
  // must not loop.
  await getDbClient().run(
    `WITH RECURSIVE descendant(id) AS (
      SELECT id FROM agent_tasks WHERE parentTaskId = ?
      UNION SELECT t.id FROM descendant d JOIN agent_tasks t ON t.parentTaskId = d.id
    ) DELETE FROM session_members WHERE taskId IN (SELECT id FROM descendant)`,
    [taskId],
  );
}

export interface SessionSummaryDrift {
  rootId: string;
  /** The field that differs, or `member` for a chain task whose members row is wrong. */
  field:
    | "summary-missing"
    | "summary-extra"
    | "chainCount"
    | "lastActivityAt"
    | "latestStatus"
    | "pendingApproval"
    | "lastHumanAt"
    | "member";
  expected: string | number | null;
  stored: string | number | null;
}

const HUMAN_TASK_SQL = `t.requestedByUserId IS NOT NULL AND t.requestedByUserIdInherited = 0
  AND COALESCE(t.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')`;

/**
 * Read-only drift check: compares the stored summaries and members with a
 * fresh chain walk (the rule `sessionSummaryQuery` applies today). Returns one
 * row per mismatch, so an empty result means the tables are exact. With
 * `since`, only roots whose chain activity is at or after it are compared.
 * `latestStatus` is skipped when two chain tasks tie on the newest
 * `lastUpdatedAt`: the walk then picks an arbitrary one.
 */
export function sessionSummaryDriftQuery(since: string | null = null): {
  sql: string;
  params: (string | null)[];
} {
  return {
    sql: `WITH RECURSIVE chain(root_id, id) AS (
      SELECT id, id FROM agent_tasks WHERE parentTaskId IS NULL
      UNION ALL SELECT c.root_id, t.id FROM chain c JOIN agent_tasks t ON t.parentTaskId = c.id
    ), walked AS (
      SELECT c.root_id, COUNT(*) AS chainCount, t.status AS latestStatus,
        MAX(t.lastUpdatedAt) AS lastActivityAt
      FROM chain c JOIN agent_tasks t ON t.id = c.id GROUP BY c.root_id
    ), expected AS (
      SELECT w.*,
        (SELECT COUNT(*) FROM chain c JOIN agent_tasks t ON t.id = c.id
          WHERE c.root_id = w.root_id AND t.lastUpdatedAt = w.lastActivityAt) AS newest,
        EXISTS (SELECT 1 FROM chain c JOIN approval_requests ar ON ar.sourceTaskId = c.id
          WHERE c.root_id = w.root_id AND ar.status = 'pending') AS pendingApproval,
        (SELECT MAX(at) FROM (
          SELECT t.createdAt AS at FROM chain c JOIN agent_tasks t ON t.id = c.id
          WHERE c.root_id = w.root_id AND ${HUMAN_TASK_SQL}
          UNION ALL SELECT sm.created_at FROM chain c JOIN task_steering_messages sm ON sm.task_id = c.id
          WHERE c.root_id = w.root_id AND sm.created_by_kind = 'user' AND sm.status != 'cancelled'
          UNION ALL SELECT ar.createdAt FROM chain c JOIN approval_requests ar ON ar.sourceTaskId = c.id
          WHERE c.root_id = w.root_id AND ar.status = 'pending')) AS lastHumanAt
      FROM walked w WHERE (? IS NULL OR w.lastActivityAt >= ?)
    ), stored AS (
      SELECT * FROM session_summaries s WHERE (? IS NULL OR s.lastActivityAt >= ?)
    )
    SELECT e.root_id AS rootId, 'summary-missing' AS field, e.chainCount AS expected, NULL AS stored
      FROM expected e LEFT JOIN session_summaries s ON s.rootId = e.root_id WHERE s.rootId IS NULL
    UNION ALL SELECT s.rootId, 'summary-extra', NULL, s.chainCount
      FROM stored s LEFT JOIN walked w ON w.root_id = s.rootId WHERE w.root_id IS NULL
    UNION ALL SELECT e.root_id, 'chainCount', e.chainCount, s.chainCount
      FROM expected e JOIN session_summaries s ON s.rootId = e.root_id WHERE s.chainCount IS NOT e.chainCount
    UNION ALL SELECT e.root_id, 'lastActivityAt', e.lastActivityAt, s.lastActivityAt
      FROM expected e JOIN session_summaries s ON s.rootId = e.root_id
      WHERE s.lastActivityAt IS NOT e.lastActivityAt
    UNION ALL SELECT e.root_id, 'latestStatus', e.latestStatus, s.latestStatus
      FROM expected e JOIN session_summaries s ON s.rootId = e.root_id
      WHERE e.newest = 1 AND s.latestStatus IS NOT e.latestStatus
    UNION ALL SELECT e.root_id, 'pendingApproval', e.pendingApproval, s.pendingApprovalCount > 0
      FROM expected e JOIN session_summaries s ON s.rootId = e.root_id
      WHERE (s.pendingApprovalCount > 0) IS NOT e.pendingApproval
    UNION ALL SELECT e.root_id, 'lastHumanAt', e.lastHumanAt, s.lastHumanAt
      FROM expected e JOIN session_summaries s ON s.rootId = e.root_id
      WHERE s.lastHumanAt IS NOT e.lastHumanAt
    UNION ALL SELECT c.root_id, 'member', c.id, m.rootId
      FROM chain c JOIN expected e ON e.root_id = c.root_id
      LEFT JOIN session_members m ON m.taskId = c.id WHERE m.rootId IS NOT c.root_id
    UNION ALL SELECT m.rootId, 'member', NULL, m.taskId
      FROM session_members m LEFT JOIN chain c ON c.id = m.taskId AND c.root_id = m.rootId
      WHERE c.id IS NULL AND (? IS NULL OR m.rootId IN (SELECT rootId FROM stored))`,
    params: [since, since, since, since, since],
  };
}

/** Run {@link sessionSummaryDriftQuery}. */
export async function findSessionSummaryDrift(
  since: string | null = null,
): Promise<SessionSummaryDrift[]> {
  const query = sessionSummaryDriftQuery(since);
  return await getDbClient().query<SessionSummaryDrift>(query.sql, query.params);
}
