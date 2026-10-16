-- Per-row flag: does this swarm_config row reach an agent's process env?
-- Workers export a row into the harness env (and so into every agent shell)
-- only when exportToEnv = 1. Rows with 0 stay server-side and are used through
-- connections or script credential bindings.
--
-- Existing rows keep today's behaviour (exported), so nothing breaks at deploy.
ALTER TABLE swarm_config ADD COLUMN exportToEnv INTEGER NOT NULL DEFAULT 1;

-- Deny list: rows only the API server reads. The first block matches
-- ENV_EXPORT_RESTRICTED_KEYS in src/utils/config-env-export.ts (never
-- exportable); the second block (ENV_EXPORT_DEFAULT_OFF_KEYS, also the insert
-- default for new rows) is off by default but operators may turn it
-- back on per row.
UPDATE swarm_config SET exportToEnv = 0
WHERE upper(key) IN (
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_WEBHOOK_SECRET',
    'GITLAB_WEBHOOK_SECRET',
    'LINEAR_CLIENT_SECRET',
    'LINEAR_SIGNING_SECRET',
    'JIRA_CLIENT_SECRET',
    'JIRA_WEBHOOK_TOKEN',
    'AZURE_DEVOPS_WEBHOOK_SECRET',
    'AGENTMAIL_WEBHOOK_SECRET',
    'API_AGENT_FS_API_KEY',
    'KAPSO_WEBHOOK_HMAC_SECRET',
    'SENTRY_TEST_APP_WEBHOOK_SECRET',
    'TELEMETRY_CH_AUTH',
    'HACK_AGENT_FS_ADMIN_KEY',
    'X_CLIENT_SECRET'
  )
  OR key GLOB 'connection.*.secret';
