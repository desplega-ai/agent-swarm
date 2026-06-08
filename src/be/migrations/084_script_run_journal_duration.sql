-- Script Workflows: record real per-step wall-clock duration (ms) measured in the
-- subprocess, so the dashboard can render a truthful waterfall. Nullable — existing
-- journal rows stay NULL and are treated as "unmeasured".

ALTER TABLE script_run_journal ADD COLUMN durationMs INTEGER;
