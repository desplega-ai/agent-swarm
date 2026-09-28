-- Attempt fence for the heartbeat Reclaim (specs/tla/heartbeat/HeartbeatSimple.tla
-- `Fenced`). Every start of an attempt (poll start, pool claim, paused resume)
-- stamps the runtime instance that started it. Worker writes to an in_progress
-- row (store-progress, defer-task, /finish, active-session cleanup) from a
-- different runtime of the same agent are the stale attempt the heartbeat took
-- the row away from, and are rejected.
-- NULL = started by a caller that sent no X-Runtime-Instance-ID (legacy worker,
-- remote harness); the fence then falls back to the status + agent check.
ALTER TABLE agent_tasks ADD COLUMN attemptRuntimeId TEXT;
