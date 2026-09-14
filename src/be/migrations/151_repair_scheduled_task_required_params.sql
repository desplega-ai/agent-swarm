-- Migration 141 added requirements by canonical name even when an existing
-- schedule already contained concrete values instead of template placeholders.
-- Restore its unbound timezone first so TIMEZONE is pruned in the same pass
-- unless the task body still references it. Keep operator-supplied bindings.
UPDATE scheduled_tasks
SET timezone = 'UTC'
WHERE name = 'weekly-dependabot-triage'
  AND timezone = '{{TIMEZONE}}'
  AND json_extract(params, '$.TIMEZONE') IS NULL;

-- Only remove requirements that the row does not consume. Scope this repair to
-- the names backfilled by 141; leave custom schedules and integration gates alone.
-- The EXISTS guard also leaves already-correct JSON byte-for-byte unchanged.
UPDATE scheduled_tasks
SET requiredParams = (
  SELECT json_group_array(value)
  FROM json_each(scheduled_tasks.requiredParams)
  WHERE instr(COALESCE(scheduled_tasks.taskTemplate, ''), '{{' || value || '}}') > 0
     OR instr(COALESCE(scheduled_tasks.timezone, ''), '{{' || value || '}}') > 0
)
WHERE name IN (
  'daily-blocker-digest',
  'daily-compounding-reflection',
  'daily-status-report',
  'daily-workflow-health-audit',
  'weekly-harness-upgrade-check',
  'weekly-dependabot-triage',
  'weekly-code-health-reports',
  'weekly-dora-metrics',
  'daily-hn-briefing',
  'gtm-weekly-review',
  'dream-daily'
)
AND EXISTS (
  SELECT 1
  FROM json_each(scheduled_tasks.requiredParams)
  WHERE instr(COALESCE(scheduled_tasks.taskTemplate, ''), '{{' || value || '}}') = 0
    AND instr(COALESCE(scheduled_tasks.timezone, ''), '{{' || value || '}}') = 0
);
