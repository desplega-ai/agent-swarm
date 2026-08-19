-- Record which runtime process owns each session so a worker starting up can
-- clear its own leftovers without deleting a sibling runtime's live session
-- (and thereby requeuing a task another process is still executing).
--
-- Nullable: sessions created before this column, and single-runtime
-- deployments, simply carry NULL and keep the existing agent-wide semantics.
ALTER TABLE active_sessions ADD COLUMN runtimeInstanceId TEXT;

CREATE INDEX idx_active_sessions_runtime ON active_sessions(runtimeInstanceId);
