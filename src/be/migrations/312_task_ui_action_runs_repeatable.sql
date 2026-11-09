-- Repeatable `script` card actions: a lease lock across API processes, a
-- cooldown, and the outcome of the last run. `follow_up` rows ignore these.
ALTER TABLE task_ui_action_runs ADD COLUMN locked_until TEXT;
ALTER TABLE task_ui_action_runs ADD COLUMN last_run_at TEXT;
ALTER TABLE task_ui_action_runs ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_ui_action_runs ADD COLUMN last_error TEXT;
