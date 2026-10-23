-- Sessions v2: a one-time Inbox cleanup. Until now a session with no triage
-- row stayed in the Inbox forever, so long-time users opened an Inbox with
-- thousands of old sessions.
--
-- For every user who sees a session in the sessions v2 tree (the owner, a
-- direct share, or a share with everyone), the session moves to Done when it
-- reads as "read" for that user, its chain had no activity in the last 7
-- days, its latest task is finished (completed, failed, cancelled, or
-- superseded), and no approval in it waits for an answer. A stuck running
-- session or a pending approval stays in the Inbox. "Read" is the rule of
-- `sessionReadStateSql` in src/be/db/session-tree.ts: no triage row (quiet
-- for 7 days is read), or an open row whose read cursor covers the newest
-- activity. Snoozed, done,
-- dismissed, and unread sessions keep their state. New activity brings a
-- Done session back to the Inbox as unread, as for a session marked Done by
-- hand. Ownerless roots are not in the tree and get no rows.

CREATE TEMP TABLE _quiet_sessions AS
WITH RECURSIVE chain(root_id, id, lastUpdatedAt, status) AS (
  SELECT id, id, lastUpdatedAt, status FROM agent_tasks
  WHERE parentTaskId IS NULL AND requestedByUserId IS NOT NULL
  UNION ALL
  SELECT c.root_id, t.id, t.lastUpdatedAt, t.status
  FROM chain c JOIN agent_tasks t ON t.parentTaskId = c.id
), activity AS (
  -- SQLite takes the bare status from the row with MAX(lastUpdatedAt), as
  -- the session list does. Keep MAX the only MIN/MAX aggregate here.
  SELECT root_id, MAX(lastUpdatedAt) AS lastActivityAt, status AS latestStatus,
    SUM(EXISTS (SELECT 1 FROM approval_requests ar
      WHERE ar.sourceTaskId = chain.id AND ar.status = 'pending')) AS pendingApproval
  FROM chain GROUP BY root_id
), quiet AS (
  SELECT root_id, lastActivityAt FROM activity
  WHERE lastActivityAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
    AND latestStatus IN ('completed', 'failed', 'cancelled', 'superseded')
    AND pendingApproval = 0
), viewers AS (
  SELECT r.requestedByUserId AS userId, q.root_id AS rootId, q.lastActivityAt
  FROM quiet q JOIN agent_tasks r ON r.id = q.root_id
  UNION
  SELECT s.userId, q.root_id, q.lastActivityAt
  FROM quiet q JOIN session_shares s ON s.rootTaskId = q.root_id
  WHERE s.revokedAt IS NULL AND s.userId IS NOT NULL
  UNION
  SELECT u.id, q.root_id, q.lastActivityAt
  FROM quiet q JOIN session_shares s ON s.rootTaskId = q.root_id CROSS JOIN users u
  WHERE s.revokedAt IS NULL AND s.userId IS NULL
)
SELECT v.userId, v.rootId, v.lastActivityAt
FROM viewers v JOIN users u ON u.id = v.userId;

-- Open rows that read as read: their cursor covers the newest activity.
UPDATE inbox_item_state
SET status = 'done',
  doneAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE itemType = 'to_read'
  AND status = 'open'
  AND EXISTS (
    SELECT 1 FROM _quiet_sessions q
    WHERE q.userId = inbox_item_state.userId
      AND q.rootId = inbox_item_state.itemId
      AND q.lastActivityAt <= COALESCE(inbox_item_state.lastReadAt, inbox_item_state.lastUpdatedAt)
  );

-- No row yet: quiet for 7 days already reads as read.
INSERT OR IGNORE INTO inbox_item_state
  (userId, itemType, itemId, status, doneAt, createdAt, lastUpdatedAt)
SELECT q.userId, 'to_read', q.rootId, 'done',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM _quiet_sessions q;

DROP TABLE _quiet_sessions;
