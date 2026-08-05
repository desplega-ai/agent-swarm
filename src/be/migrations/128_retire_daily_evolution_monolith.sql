-- Prod cutover: retire the daily-evolution monolith (daily-compounding-reflection)
-- and the daily-blocker-digest schedules, superseded by the Dreaming add-on's
-- `dream` workflow (fka compounding). See runbooks/workflows.md + docs Add-ons/Dreaming.
-- Disable, not delete — history and post-mortem references stay queryable.
-- No-op on installs that never had these rows. Do NOT re-enable.
-- Matched by unique name AND by the known prod ids (belt and braces; the prod id
-- cdfa3f00-… belongs to daily-blocker-digest, 0e960516-… to the monolith).
UPDATE scheduled_tasks SET enabled = 0 WHERE name = 'daily-compounding-reflection';
UPDATE scheduled_tasks SET enabled = 0 WHERE name = 'daily-blocker-digest';
UPDATE scheduled_tasks SET enabled = 0 WHERE id IN (
  '0e960516-8dc6-42ab-b1c3-14a8a8aab8d0',
  'cdfa3f00-0e10-4bcd-8d69-9f10b30cb9a2'
);
