-- Why a task reached its terminal status (e.g. failed + agent vs failed + error).
-- Refines `status` and never replaces it. NULL means unknown: rows finished
-- before this column existed are not backfilled. No CHECK constraint: the
-- valid kinds per status live in TASK_STATUS_KINDS (src/types.ts), so a new
-- kind needs no migration.
ALTER TABLE agent_tasks ADD COLUMN statusKind TEXT;
