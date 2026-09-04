-- Runtime values and setup requirements for fail-forward workflow automations.
-- JSON blobs follow the existing workflows definition/triggers/input convention.
ALTER TABLE workflows ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflows ADD COLUMN requiredParams TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflows ADD COLUMN requires TEXT NOT NULL DEFAULT '[]';

-- As above, match only canonical workflow names so operator-created rows are
-- never reclassified by a forward migration.
UPDATE workflows
SET requiredParams = CASE name
      WHEN 'claude-code-changelog-watch' THEN '[]'
      WHEN 'alerts-triage' THEN '["ALERTS_CHANNEL_ID"]'
      WHEN 'competitor-radar' THEN '["COMPETITORS","AGENT_FS_ORG_ID"]'
      WHEN 'gsc-topic-miner' THEN '["GSC_PROPERTY"]'
      WHEN 'docs-site-releases' THEN '["REPO_URL"]'
      WHEN 'pr-review-status-sweep' THEN '["REPO_URL"]'
      WHEN 'linear-drain-loop' THEN '["LINEAR_PROJECT_ID"]'
      WHEN 'autopilot' THEN '["REPO_URL"]'
      WHEN 'ralph-loop' THEN '["REPO_URL"]'
      WHEN 'llm-safe-release-context' THEN '["REPO_URL","ORG_ID"]'
    END,
    requires = CASE name
      WHEN 'claude-code-changelog-watch' THEN '[]'
      WHEN 'alerts-triage' THEN '["slack"]'
      WHEN 'competitor-radar' THEN '["agentfs"]'
      WHEN 'gsc-topic-miner' THEN '["gsc","agentfs"]'
      WHEN 'docs-site-releases' THEN '["github","agentfs"]'
      WHEN 'pr-review-status-sweep' THEN '["github"]'
      WHEN 'linear-drain-loop' THEN '["linear"]'
      WHEN 'autopilot' THEN '["github"]'
      WHEN 'ralph-loop' THEN '["github"]'
      WHEN 'llm-safe-release-context' THEN '["github"]'
    END
WHERE name IN (
  'claude-code-changelog-watch',
  'alerts-triage',
  'competitor-radar',
  'gsc-topic-miner',
  'docs-site-releases',
  'pr-review-status-sweep',
  'linear-drain-loop',
  'autopilot',
  'ralph-loop',
  'llm-safe-release-context'
);

-- Existing canonical workflow definitions used runtime trigger/input values
-- for fields that are now install-time parameters. Rewrite only those known
-- definitions so satisfying preflight also changes the execution target.
UPDATE workflows
SET definition = REPLACE(
      REPLACE(definition, '{{repoUrl}}', '{{REPO_URL}}'),
      '{{trigger.repoUrl}}', '{{REPO_URL}}'
    )
WHERE name IN ('autopilot', 'ralph-loop');

UPDATE workflows
SET definition = REPLACE(
      REPLACE(definition, '{{projectId}}', '{{LINEAR_PROJECT_ID}}'),
      '{{trigger.projectId}}', '{{LINEAR_PROJECT_ID}}'
    )
WHERE name = 'linear-drain-loop';
