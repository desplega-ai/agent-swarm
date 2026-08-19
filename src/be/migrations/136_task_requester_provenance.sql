-- Record whether requester attribution was copied from a parent task. This is
-- server-owned provenance: callers may set requestedByUserId, but never this
-- marker.
ALTER TABLE agent_tasks
ADD COLUMN requestedByUserIdInherited INTEGER NOT NULL DEFAULT 0
CHECK (requestedByUserIdInherited IN (0, 1));

-- Migration 127 copied requester ids through task trees before provenance was
-- stored. Reconstruct only the historical case that affects human-free
-- attribution: stale requesters propagated below heartbeat roots. An audited
-- `created_by` is durable evidence of an original human handoff and stops the
-- reconstruction. Legacy unaudited same-user handoffs are indistinguishable,
-- so this deliberately avoids guessing across ordinary human task trees.
WITH RECURSIVE inherited_from_heartbeat(id, requester, depth) AS (
  SELECT id, requestedByUserId, 0
  FROM agent_tasks
  WHERE requestedByUserId IS NOT NULL
    AND (
      IFNULL(taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
      OR IFNULL(tags, '[]') LIKE '%"heartbeat"%'
    )

  UNION ALL

  SELECT child.id, lineage.requester, lineage.depth + 1
  FROM agent_tasks AS child
  JOIN inherited_from_heartbeat AS lineage ON child.parentTaskId = lineage.id
  WHERE child.requestedByUserId = lineage.requester
    AND child.created_by IS NULL
)
UPDATE agent_tasks
SET requestedByUserIdInherited = 1
WHERE id IN (
  SELECT id
  FROM inherited_from_heartbeat
  WHERE depth > 0
);
