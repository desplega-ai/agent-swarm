-- The pi extension posted its per-LLM-call `context` usage snapshot as
-- eventType 'compaction', so every pi turn drew an AUTO COMPACTION divider and
-- bumped agent_tasks.compactionCount. Those rows never carry compactTrigger or
-- preCompactTokens (real compactions from every harness do). Relabel them as
-- 'progress' and recompute the counter for the pi tasks.

UPDATE task_context_snapshots
SET eventType = 'progress'
WHERE eventType = 'compaction'
  AND compactTrigger IS NULL
  AND preCompactTokens IS NULL
  AND sessionId LIKE 'pi-%'
  AND taskId IN (SELECT id FROM agent_tasks WHERE provider = 'pi');

UPDATE agent_tasks
SET compactionCount = (
  SELECT COUNT(*)
  FROM task_context_snapshots s
  WHERE s.taskId = agent_tasks.id AND s.eventType = 'compaction'
)
WHERE provider = 'pi'
  AND COALESCE(compactionCount, 0) > 0;
