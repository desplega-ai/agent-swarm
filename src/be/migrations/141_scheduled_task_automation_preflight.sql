-- Runtime values and setup requirements for fail-forward scheduled automations.
-- JSON blobs follow the scheduled_tasks.scriptArgs convention: TEXT columns
-- containing serialized JSON with non-null empty defaults for legacy rows.
ALTER TABLE scheduled_tasks ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_tasks ADD COLUMN requiredParams TEXT NOT NULL DEFAULT '[]';
ALTER TABLE scheduled_tasks ADD COLUMN requires TEXT NOT NULL DEFAULT '[]';

-- Existing installs predate persisted template metadata. Backfill only the
-- canonical schedule names in the approved v4 matrix; custom rows keep the
-- empty defaults above.
UPDATE scheduled_tasks
SET requiredParams = CASE name
      WHEN 'daily-blocker-digest' THEN '[]'
      WHEN 'daily-compounding-reflection' THEN '[]'
      WHEN 'daily-status-report' THEN '[]'
      WHEN 'daily-workflow-health-audit' THEN '[]'
      WHEN 'weekly-harness-upgrade-check' THEN '["REPO_URL","PR_REVIEWER"]'
      WHEN 'weekly-dependabot-triage' THEN '["REPO_URL","SLACK_CHANNEL_ID","TIMEZONE"]'
      WHEN 'weekly-code-health-reports' THEN '["REPO_URL","BRANCH","SCOPE_PATH","REPORT_NAME","PAGE_ID"]'
      WHEN 'weekly-dora-metrics' THEN '["REPO_URL","BRANCH","TAG_PATTERN","REPORT_NAME","PAGE_ID"]'
      WHEN 'daily-hn-briefing' THEN '["REPORT_EMAIL"]'
      WHEN 'gtm-weekly-review' THEN '["REPO_URL","GSC_PROPERTY"]'
      WHEN 'dream-daily' THEN '[]'
    END,
    requires = CASE name
      WHEN 'daily-blocker-digest' THEN '[]'
      WHEN 'daily-compounding-reflection' THEN '[]'
      WHEN 'daily-status-report' THEN '[]'
      WHEN 'daily-workflow-health-audit' THEN '[]'
      WHEN 'weekly-harness-upgrade-check' THEN '["github"]'
      WHEN 'weekly-dependabot-triage' THEN '["github","slack"]'
      WHEN 'weekly-code-health-reports' THEN '["github"]'
      WHEN 'weekly-dora-metrics' THEN '["github"]'
      WHEN 'daily-hn-briefing' THEN '["agentmail"]'
      WHEN 'gtm-weekly-review' THEN '["github","gsc"]'
      WHEN 'dream-daily' THEN '[]'
    END
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
);

-- Tokenize the known placeholder values in legacy canonical bodies. Keep the
-- replacements scoped by exact template name so operator-authored schedules
-- remain byte-for-byte unchanged.
UPDATE scheduled_tasks
SET taskTemplate = REPLACE(taskTemplate, 'owner/repo', '{{REPO_URL}}')
WHERE name IN ('weekly-dependabot-triage', 'gtm-weekly-review')
  AND taskTemplate IS NOT NULL;

UPDATE scheduled_tasks
SET taskTemplate = REPLACE(taskTemplate, 'the configured channel or thread', '{{SLACK_CHANNEL_ID}}')
WHERE name = 'weekly-dependabot-triage'
  AND taskTemplate IS NOT NULL;

UPDATE scheduled_tasks
SET taskTemplate = REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(taskTemplate, 'https://github.com/OWNER/REPO.git', '{{REPO_URL}}'),
            'my-repo', '{{REPORT_NAME}}'
          ),
          '<PAGE_ID>', '{{PAGE_ID}}'
        ),
        'BRANCH=main', 'BRANCH={{BRANCH}}'
      ),
      'SCOPE_PATH=src', 'SCOPE_PATH={{SCOPE_PATH}}'
    )
WHERE name = 'weekly-code-health-reports'
  AND taskTemplate IS NOT NULL;

UPDATE scheduled_tasks
SET taskTemplate = REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(taskTemplate, 'https://github.com/OWNER/REPO.git', '{{REPO_URL}}'),
            'my-repo', '{{REPORT_NAME}}'
          ),
          '<PAGE_ID>', '{{PAGE_ID}}'
        ),
        'BRANCH=main', 'BRANCH={{BRANCH}}'
      ),
      'TAG_PATTERN=''v*''', 'TAG_PATTERN={{TAG_PATTERN}}'
    )
WHERE name = 'weekly-dora-metrics'
  AND taskTemplate IS NOT NULL;

UPDATE scheduled_tasks
SET taskTemplate = REPLACE(
      REPLACE(
        REPLACE(taskTemplate, 'Default branch: `main`', 'Default branch: `{{BRANCH}}`'),
        'Path scope: `src`', 'Path scope: `{{SCOPE_PATH}}`'
      ),
      'Release tag pattern: `v*`', 'Release tag pattern: `{{TAG_PATTERN}}`'
    )
WHERE name IN ('weekly-code-health-reports', 'weekly-dora-metrics')
  AND taskTemplate IS NOT NULL;

UPDATE scheduled_tasks
SET taskTemplate = REPLACE(
      REPLACE(
        REPLACE(taskTemplate,
          'the configured recipient list for this briefing', '{{REPORT_EMAIL}}'),
        'use the configured recipient list for this briefing', '{{REPORT_EMAIL}}'
      ),
      'lead@agent-swarm.dev', 'the configured reporting inbox'
    )
WHERE name = 'daily-hn-briefing'
  AND taskTemplate IS NOT NULL;

UPDATE scheduled_tasks
SET taskTemplate = REPLACE(
      taskTemplate,
      'example.com docs.example.com',
      '{{GSC_PROPERTY}}'
    )
WHERE name = 'gtm-weekly-review'
  AND taskTemplate IS NOT NULL;

-- weekly-dependabot-triage is the one legacy row whose persisted cadence
-- timezone is an install parameter rather than a fixed template default.
UPDATE scheduled_tasks
SET timezone = '{{TIMEZONE}}'
WHERE name = 'weekly-dependabot-triage';
