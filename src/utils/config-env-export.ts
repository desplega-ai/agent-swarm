/**
 * Whether a swarm_config row reaches an agent's process environment.
 *
 * Each row carries an `exportToEnv` flag (migration 215). Workers export a row
 * into the harness env, and so into `env`, `printenv` and `/proc/<pid>/environ`
 * of every agent shell, only when the flag is true. Rows with the flag off stay
 * server-side: agents use them through a connection or a script credential
 * binding instead.
 *
 * Keys below are read only by the API server (integration signing secrets, app
 * private keys, OAuth client secrets, the API's own agent-fs key). They can
 * never be exported: the config API rejects `exportToEnv: true` for them and
 * every reader treats a stored true as false.
 */
export const ENV_EXPORT_RESTRICTED_KEYS: ReadonlySet<string> = new Set([
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITLAB_WEBHOOK_SECRET",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_SIGNING_SECRET",
  "JIRA_CLIENT_SECRET",
  "JIRA_WEBHOOK_TOKEN",
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "AGENTMAIL_WEBHOOK_SECRET",
  "API_AGENT_FS_API_KEY",
]);

/** Script connection secrets (`connection.<slug>.secret`) are brokered server-side. */
const CONNECTION_SECRET_KEY = /^connection\..+\.secret$/;

export function isEnvExportRestrictedKey(key: string): boolean {
  return ENV_EXPORT_RESTRICTED_KEYS.has(key.toUpperCase()) || CONNECTION_SECRET_KEY.test(key);
}

export function envExportRestrictedError(key: string): string {
  return `Key '${key}' is read only by the API server and can never be exported to agent env; store it with exportToEnv: false.`;
}

/** The flag readers act on: a stored true never wins for a restricted key. */
export function effectiveExportToEnv(key: string, stored: boolean): boolean {
  return stored && !isEnvExportRestrictedKey(key);
}
