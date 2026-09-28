-- Usage page (GET /api/session-costs/summary, /api/attribution/by-person).
--
-- A task row stores its full prompt (about 20 KB on average in production)
-- before these columns, so every read of them follows the row's overflow
-- pages. The human-free classification scans all tasks and the session join
-- probes one task per session. This covering index serves both without
-- reading a task row: 861 ms to about 160 ms for a 30-day summary on a
-- production-shaped DB (38k tasks, 45k sessions).
CREATE INDEX IF NOT EXISTS idx_agent_tasks_usage_cover
  ON agent_tasks(
    id, parentTaskId, requestedByUserId, requestedByUserIdInherited,
    taskType, source, tags, workflowRunId, credentialKeyType, credentialKeySuffix
  );

-- Subscription plan of a pooled OAuth credential (src/utils/subscription-plans.ts).
-- `planSource` is 'manual' (picked on the dashboard), 'detected' (reported by a
-- worker, for example the Codex JWT plan claim) or 'estimated' (a Claude plan
-- derived from rate-limit utilization). That is also the precedence: a source
-- never replaces a stronger one. Every scope row of one keyType + keySuffix
-- holds the same plan.
ALTER TABLE api_key_status ADD COLUMN plan TEXT;
ALTER TABLE api_key_status ADD COLUMN planSource TEXT;
