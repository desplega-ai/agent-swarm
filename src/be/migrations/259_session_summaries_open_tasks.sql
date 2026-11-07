-- What the session read path needs from session_summaries (migration 253):
-- the key and source indexes its filters use, and openTaskCount, the number
-- of chain tasks that are not finished (status outside completed, failed,
-- cancelled, superseded).
--
-- Auto-Done (src/be/db/session-tree.ts) moves a quiet Inbox session to Done
-- only when every chain task is finished. The session read path now reads
-- session_summaries instead of walking the chain, so the summary carries the
-- count. Same consistency rules as migration 253:
-- - Inserts add the new task's count incrementally.
-- - A status change applies its +1 or -1 in a BEFORE trigger. An AFTER
--   trigger of the same statement that recomputes the chain (a rewound
--   lastUpdatedAt, a requester or source edit) then overwrites it with the
--   exact count, so the delta is never applied on top of a recompute.
-- - session_summary_recompute_apply recomputes it with the other aggregates.

ALTER TABLE session_summaries ADD COLUMN openTaskCount INTEGER NOT NULL DEFAULT 0;

-- The group (key range) and source filters of the list and count. Activity
-- writes do not touch either column, so neither index costs the hot path.
CREATE INDEX idx_session_summaries_key ON session_summaries("key");
CREATE INDEX idx_session_summaries_source ON session_summaries(source);

DROP TRIGGER session_summary_recompute_apply;
CREATE TRIGGER session_summary_recompute_apply
INSTEAD OF INSERT ON session_summary_recompute
BEGIN
  UPDATE session_summaries SET
    chainCount = (SELECT COUNT(*) FROM session_members m WHERE m.rootId = NEW.rootId),
    lastActivityAt = (SELECT MAX(t.lastUpdatedAt) FROM session_members m
      JOIN agent_tasks t ON t.id = m.taskId WHERE m.rootId = NEW.rootId),
    latestStatus = (SELECT t.status FROM session_members m
      JOIN agent_tasks t ON t.id = m.taskId WHERE m.rootId = NEW.rootId
      ORDER BY t.lastUpdatedAt DESC LIMIT 1),
    pendingApprovalCount = (SELECT COUNT(*) FROM session_members m
      JOIN approval_requests ar ON ar.sourceTaskId = m.taskId
      WHERE m.rootId = NEW.rootId AND ar.status = 'pending'),
    openTaskCount = (SELECT COUNT(*) FROM session_members m
      JOIN agent_tasks t ON t.id = m.taskId WHERE m.rootId = NEW.rootId
      AND t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')),
    lastHumanAt = (SELECT MAX(at) FROM (
      SELECT t.createdAt AS at FROM session_members m JOIN agent_tasks t ON t.id = m.taskId
      WHERE m.rootId = NEW.rootId AND t.requestedByUserId IS NOT NULL
        AND t.requestedByUserIdInherited = 0
        AND COALESCE(t.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      UNION ALL
      SELECT sm.created_at FROM session_members m
      JOIN task_steering_messages sm ON sm.task_id = m.taskId
      WHERE m.rootId = NEW.rootId AND sm.created_by_kind = 'user' AND sm.status != 'cancelled'
      UNION ALL
      SELECT ar.createdAt FROM session_members m
      JOIN approval_requests ar ON ar.sourceTaskId = m.taskId
      WHERE m.rootId = NEW.rootId AND ar.status = 'pending'))
  WHERE rootId = NEW.rootId
    AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = NEW.rootId);
END;

DROP TRIGGER session_task_insert;
CREATE TRIGGER session_task_insert
AFTER INSERT ON agent_tasks
BEGIN
  INSERT OR REPLACE INTO session_members (taskId, rootId)
  SELECT NEW.id, NEW.id WHERE NEW.parentTaskId IS NULL
  UNION ALL
  SELECT NEW.id, m.rootId FROM session_members m WHERE m.taskId = NEW.parentTaskId;

  INSERT OR REPLACE INTO session_summaries (rootId, createdAt, source, "key", requestedByUserId,
    scheduleId, taskType, slackChannelId, contextKey, chainCount, lastActivityAt, latestStatus,
    pendingApprovalCount, openTaskCount, lastHumanAt)
  SELECT NEW.id, NEW.createdAt, NEW.source, NEW."key", NEW.requestedByUserId, NEW.scheduleId,
    NEW.taskType, NEW.slackChannelId, NEW.contextKey, 1, NEW.lastUpdatedAt, NEW.status, 0,
    NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'),
    CASE WHEN NEW.requestedByUserId IS NOT NULL AND NEW.requestedByUserIdInherited = 0
      AND COALESCE(NEW.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      THEN NEW.createdAt END
  WHERE NEW.parentTaskId IS NULL;

  UPDATE session_summaries SET
    chainCount = chainCount + 1,
    openTaskCount = openTaskCount
      + (NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')),
    latestStatus = CASE WHEN NEW.lastUpdatedAt >= lastActivityAt THEN NEW.status ELSE latestStatus END,
    lastActivityAt = MAX(lastActivityAt, NEW.lastUpdatedAt),
    lastHumanAt = CASE WHEN NEW.requestedByUserId IS NOT NULL AND NEW.requestedByUserIdInherited = 0
      AND COALESCE(NEW.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      AND (lastHumanAt IS NULL OR NEW.createdAt > lastHumanAt)
      THEN NEW.createdAt ELSE lastHumanAt END
  WHERE NEW.parentTaskId IS NOT NULL
    AND rootId = (SELECT rootId FROM session_members WHERE taskId = NEW.id);
END;

-- BEFORE, so an AFTER recompute in the same statement has the last word.
CREATE TRIGGER session_task_open
BEFORE UPDATE OF status ON agent_tasks
WHEN (OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'))
  IS NOT (NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'))
BEGIN
  UPDATE session_summaries SET
    openTaskCount = openTaskCount
      + CASE WHEN NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded') THEN 1 ELSE -1 END
  WHERE rootId = (SELECT rootId FROM session_members WHERE taskId = NEW.id);
END;

-- Backfill: one pass over the unfinished tasks.
UPDATE session_summaries SET openTaskCount = unfinished.n
FROM (
  SELECT m.rootId, COUNT(*) AS n FROM agent_tasks t JOIN session_members m ON m.taskId = t.id
  WHERE t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
  GROUP BY m.rootId
) AS unfinished
WHERE unfinished.rootId = session_summaries.rootId;
