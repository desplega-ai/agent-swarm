-- Session summaries: one narrow row per session root, kept exact by triggers.
--
-- A session is a root task (parentTaskId IS NULL) plus every task reachable
-- through parentTaskId. The session list, count and tree walk that chain with
-- a recursive CTE on every request (src/be/db/session-tree.ts). These tables
-- store the walk's result so the read path can skip it:
--
-- - session_members(taskId, rootId): the root of every chain task. A task
--   whose parent is missing belongs to no session, as in the chain walk.
-- - session_summaries(rootId, ...): copies of the root columns the list
--   filters on, plus the chain aggregates the list, count and tree read.
--
-- Nothing reads these tables yet. The read path switches over in a later
-- change, after a production drift check against the chain walk
-- (sessionSummaryDriftQuery in src/be/db/session-summaries.ts).
--
-- Consistency rules:
-- - Inserts and progress writes update a summary incrementally (the hot path).
-- - Rare, non-monotonic changes recompute the whole chain through the
--   session_summary_recompute view, the one copy of the recompute SQL.
-- - parentTaskId is immutable: no code moves a task between chains, and the
--   members table depends on it. Changing it aborts.
-- - Trigger bodies cannot use WITH, so deleteTask (the only task delete)
--   drops the members rows of a deleted task's descendants itself, before the
--   DELETE. The delete trigger then recomputes the chain.
-- - session_summary_recompute_apply reads agent_tasks, task_steering_messages
--   and approval_requests. A later migration that rebuilds one of those
--   tables (create, copy, drop, rename) must drop that trigger before the
--   rename and re-create it after, or the rename fails its schema check. The
--   boot-time agent_tasks rebuild in src/be/db/runtime.ts already does.

CREATE TABLE session_members (
  taskId TEXT PRIMARY KEY,
  rootId TEXT NOT NULL
);
CREATE INDEX idx_session_members_root ON session_members(rootId);

CREATE TABLE session_summaries (
  rootId TEXT PRIMARY KEY,
  -- Root copies (filters, ordering, tree grouping).
  createdAt TEXT NOT NULL,
  source TEXT,
  "key" TEXT NOT NULL,
  requestedByUserId TEXT,
  scheduleId TEXT,
  taskType TEXT,
  slackChannelId TEXT,
  contextKey TEXT,
  -- Chain aggregates.
  chainCount INTEGER NOT NULL,
  lastActivityAt TEXT NOT NULL,
  latestStatus TEXT NOT NULL,
  pendingApprovalCount INTEGER NOT NULL DEFAULT 0,
  -- Newest event that reopens a Done session: a human message (a task a
  -- person requested directly from a human channel), a person's live steering
  -- message, or a pending approval. Done reopens when this is newer than the
  -- Done mark, which is what the chain walk's per-row check asks.
  lastHumanAt TEXT
);
CREATE INDEX idx_session_summaries_activity
  ON session_summaries(lastActivityAt DESC, createdAt DESC, rootId DESC);
CREATE INDEX idx_session_summaries_thread
  ON session_summaries("key") WHERE requestedByUserId IS NOT NULL;

-- INSERT INTO session_summary_recompute (rootId) VALUES (?) recomputes one
-- summary from its members. A missing root is a no-op, including a root whose
-- row is mid-delete: an FK cascade (steering messages) fires its trigger after
-- the row is gone but before the delete trigger drops the summary.
CREATE VIEW session_summary_recompute AS SELECT NULL AS rootId;

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

-- A new root opens a session; a new child joins its parent's session. A child
-- of a missing parent joins nothing (task ids are fresh UUIDs, so no later
-- insert can adopt it).
CREATE TRIGGER session_task_insert
AFTER INSERT ON agent_tasks
BEGIN
  INSERT OR REPLACE INTO session_members (taskId, rootId)
  SELECT NEW.id, NEW.id WHERE NEW.parentTaskId IS NULL
  UNION ALL
  SELECT NEW.id, m.rootId FROM session_members m WHERE m.taskId = NEW.parentTaskId;

  INSERT OR REPLACE INTO session_summaries (rootId, createdAt, source, "key", requestedByUserId,
    scheduleId, taskType, slackChannelId, contextKey, chainCount, lastActivityAt, latestStatus,
    pendingApprovalCount, lastHumanAt)
  SELECT NEW.id, NEW.createdAt, NEW.source, NEW."key", NEW.requestedByUserId, NEW.scheduleId,
    NEW.taskType, NEW.slackChannelId, NEW.contextKey, 1, NEW.lastUpdatedAt, NEW.status, 0,
    CASE WHEN NEW.requestedByUserId IS NOT NULL AND NEW.requestedByUserIdInherited = 0
      AND COALESCE(NEW.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      THEN NEW.createdAt END
  WHERE NEW.parentTaskId IS NULL;

  UPDATE session_summaries SET
    chainCount = chainCount + 1,
    latestStatus = CASE WHEN NEW.lastUpdatedAt >= lastActivityAt THEN NEW.status ELSE latestStatus END,
    lastActivityAt = MAX(lastActivityAt, NEW.lastUpdatedAt),
    lastHumanAt = CASE WHEN NEW.requestedByUserId IS NOT NULL AND NEW.requestedByUserIdInherited = 0
      AND COALESCE(NEW.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      AND (lastHumanAt IS NULL OR NEW.createdAt > lastHumanAt)
      THEN NEW.createdAt ELSE lastHumanAt END
  WHERE NEW.parentTaskId IS NOT NULL
    AND rootId = (SELECT rootId FROM session_members WHERE taskId = NEW.id);
END;

-- Progress and status writes (the hot path): newest activity wins.
CREATE TRIGGER session_task_activity
AFTER UPDATE OF lastUpdatedAt, status ON agent_tasks
WHEN NEW.lastUpdatedAt >= OLD.lastUpdatedAt
BEGIN
  UPDATE session_summaries SET
    latestStatus = CASE WHEN NEW.lastUpdatedAt >= lastActivityAt THEN NEW.status ELSE latestStatus END,
    lastActivityAt = MAX(lastActivityAt, NEW.lastUpdatedAt)
  WHERE rootId = (SELECT rootId FROM session_members WHERE taskId = NEW.id);
END;

-- A timestamp moved back may have been the chain's newest one.
CREATE TRIGGER session_task_activity_rewind
AFTER UPDATE OF lastUpdatedAt ON agent_tasks
WHEN NEW.lastUpdatedAt < OLD.lastUpdatedAt
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = NEW.id;
END;

-- Requester or source edits change which tasks count as human messages.
CREATE TRIGGER session_task_human
AFTER UPDATE OF requestedByUserId, requestedByUserIdInherited, source, createdAt ON agent_tasks
WHEN OLD.requestedByUserId IS NOT NEW.requestedByUserId
  OR OLD.requestedByUserIdInherited IS NOT NEW.requestedByUserIdInherited
  OR OLD.source IS NOT NEW.source
  OR OLD.createdAt IS NOT NEW.createdAt
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = NEW.id;
END;

-- Root column copies (session moves rewrite the root key).
CREATE TRIGGER session_root_columns
AFTER UPDATE OF createdAt, source, "key", requestedByUserId, scheduleId, taskType,
  slackChannelId, contextKey ON agent_tasks
WHEN NEW.parentTaskId IS NULL AND (
  OLD.createdAt IS NOT NEW.createdAt OR OLD.source IS NOT NEW.source
  OR OLD."key" IS NOT NEW."key" OR OLD.requestedByUserId IS NOT NEW.requestedByUserId
  OR OLD.scheduleId IS NOT NEW.scheduleId OR OLD.taskType IS NOT NEW.taskType
  OR OLD.slackChannelId IS NOT NEW.slackChannelId OR OLD.contextKey IS NOT NEW.contextKey)
BEGIN
  UPDATE session_summaries SET
    createdAt = NEW.createdAt, source = NEW.source, "key" = NEW."key",
    requestedByUserId = NEW.requestedByUserId, scheduleId = NEW.scheduleId,
    taskType = NEW.taskType, slackChannelId = NEW.slackChannelId, contextKey = NEW.contextKey
  WHERE rootId = NEW.id;
END;

CREATE TRIGGER session_task_parent_immutable
BEFORE UPDATE OF parentTaskId ON agent_tasks
WHEN OLD.parentTaskId IS NOT NEW.parentTaskId
BEGIN
  SELECT RAISE(ABORT, 'agent_tasks.parentTaskId is immutable (session_members depends on it)');
END;

-- A deleted root ends its session, and its chain tasks join nothing. A deleted
-- chain task leaves its chain (deleteTask already dropped its descendants).
CREATE TRIGGER session_task_delete
AFTER DELETE ON agent_tasks
BEGIN
  DELETE FROM session_members WHERE taskId = OLD.id OR rootId = OLD.id;
  DELETE FROM session_summaries WHERE rootId = OLD.id;
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = OLD.parentTaskId;
END;

-- Steering messages and approvals are rare: recompute on any change that
-- can move lastHumanAt or pendingApprovalCount.
CREATE TRIGGER session_steering_insert
AFTER INSERT ON task_steering_messages
WHEN NEW.created_by_kind = 'user' AND NEW.status != 'cancelled'
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = NEW.task_id;
END;

CREATE TRIGGER session_steering_update
AFTER UPDATE OF task_id, created_by_kind, status, created_at ON task_steering_messages
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.created_by_kind IS NOT NEW.created_by_kind
  OR OLD.created_at IS NOT NEW.created_at
  OR (OLD.status = 'cancelled') IS NOT (NEW.status = 'cancelled')
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId IN (OLD.task_id, NEW.task_id);
END;

CREATE TRIGGER session_steering_delete
AFTER DELETE ON task_steering_messages
WHEN OLD.created_by_kind = 'user' AND OLD.status != 'cancelled'
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = OLD.task_id;
END;

CREATE TRIGGER session_approval_insert
AFTER INSERT ON approval_requests
WHEN NEW.sourceTaskId IS NOT NULL AND NEW.status = 'pending'
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = NEW.sourceTaskId;
END;

CREATE TRIGGER session_approval_update
AFTER UPDATE OF sourceTaskId, status, createdAt ON approval_requests
WHEN OLD.sourceTaskId IS NOT NEW.sourceTaskId OR OLD.createdAt IS NOT NEW.createdAt
  OR (OLD.status = 'pending') IS NOT (NEW.status = 'pending')
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId IN (OLD.sourceTaskId, NEW.sourceTaskId);
END;

CREATE TRIGGER session_approval_delete
AFTER DELETE ON approval_requests
WHEN OLD.sourceTaskId IS NOT NULL AND OLD.status = 'pending'
BEGIN
  INSERT INTO session_summary_recompute (rootId)
  SELECT rootId FROM session_members WHERE taskId = OLD.sourceTaskId;
END;

-- Backfill: one chain walk for the members, then set-based aggregates (a
-- recompute per root reads every chain task several times). The packed MAX
-- takes the status of the newest task, as the bare column does in the walk.
INSERT INTO session_members (taskId, rootId)
WITH RECURSIVE chain(root_id, id) AS (
  SELECT id, id FROM agent_tasks WHERE parentTaskId IS NULL
  UNION ALL
  SELECT c.root_id, t.id FROM chain c JOIN agent_tasks t ON t.parentTaskId = c.id
)
SELECT id, root_id FROM chain;

INSERT INTO session_summaries (rootId, createdAt, source, "key", requestedByUserId, scheduleId,
  taskType, slackChannelId, contextKey, chainCount, lastActivityAt, latestStatus, lastHumanAt)
SELECT r.id, r.createdAt, r.source, r."key", r.requestedByUserId, r.scheduleId, r.taskType,
  r.slackChannelId, r.contextKey, w.chainCount, w.lastActivityAt,
  substr(w.newest, instr(w.newest, char(31)) + 1), w.humanAt
FROM (
  SELECT m.rootId, COUNT(*) AS chainCount, MAX(t.lastUpdatedAt) AS lastActivityAt,
    MAX(t.lastUpdatedAt || char(31) || t.status) AS newest,
    MAX(CASE WHEN t.requestedByUserId IS NOT NULL AND t.requestedByUserIdInherited = 0
      AND COALESCE(t.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      THEN t.createdAt END) AS humanAt
  FROM session_members m JOIN agent_tasks t ON t.id = m.taskId
  GROUP BY m.rootId
) w JOIN agent_tasks r ON r.id = w.rootId;

UPDATE session_summaries SET
  pendingApprovalCount = (SELECT COUNT(*) FROM session_members m
    JOIN approval_requests ar ON ar.sourceTaskId = m.taskId
    WHERE m.rootId = session_summaries.rootId AND ar.status = 'pending'),
  lastHumanAt = (SELECT MAX(at) FROM (
    SELECT session_summaries.lastHumanAt AS at
    UNION ALL
    SELECT sm.created_at FROM session_members m
    JOIN task_steering_messages sm ON sm.task_id = m.taskId
    WHERE m.rootId = session_summaries.rootId AND sm.created_by_kind = 'user'
      AND sm.status != 'cancelled'
    UNION ALL
    SELECT ar.createdAt FROM session_members m
    JOIN approval_requests ar ON ar.sourceTaskId = m.taskId
    WHERE m.rootId = session_summaries.rootId AND ar.status = 'pending'))
WHERE rootId IN (
  SELECT m.rootId FROM session_members m JOIN task_steering_messages sm ON sm.task_id = m.taskId
  WHERE sm.created_by_kind = 'user' AND sm.status != 'cancelled'
  UNION
  SELECT m.rootId FROM session_members m JOIN approval_requests ar ON ar.sourceTaskId = m.taskId
  WHERE ar.status = 'pending');
