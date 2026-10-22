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
 * private keys, OAuth client secrets, the API's own agent-fs and
 * speech-to-text keys). They can
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
  "BITBUCKET_WEBHOOK_SECRET",
  "AGENTMAIL_WEBHOOK_SECRET",
  "API_AGENT_FS_API_KEY",
  "TRANSCRIPTION_API_KEY",
]);

/**
 * Server-side secrets an operator may still export per row. A new row for one
 * of these keys starts with the flag off unless the caller sends
 * `exportToEnv: true`. Migration 215 applies the same default to rows that
 * already existed.
 */
export const ENV_EXPORT_DEFAULT_OFF_KEYS: ReadonlySet<string> = new Set([
  "KAPSO_WEBHOOK_HMAC_SECRET",
  "SENTRY_TEST_APP_WEBHOOK_SECRET",
  "TELEMETRY_CH_AUTH",
  "HACK_AGENT_FS_ADMIN_KEY",
  "X_CLIENT_SECRET",
]);

/** Script connection secrets (`connection.<slug>.secret`) are brokered server-side. */
const CONNECTION_SECRET_KEY = /^connection\..+\.secret$/;

/**
 * Key prefixes whose rows start with the flag off: the API server reads them
 * (Chat SDK bot tokens and adapter JSON), agents never need them in a shell.
 */
const ENV_EXPORT_DEFAULT_OFF_PREFIXES = ["CHAT_SDK_"];

export function isEnvExportRestrictedKey(key: string): boolean {
  return ENV_EXPORT_RESTRICTED_KEYS.has(key.toUpperCase()) || CONNECTION_SECRET_KEY.test(key);
}

/** The flag a new row gets when the caller does not send one. */
export function defaultExportToEnv(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    !isEnvExportRestrictedKey(key) &&
    !ENV_EXPORT_DEFAULT_OFF_KEYS.has(upper) &&
    !ENV_EXPORT_DEFAULT_OFF_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

export function envExportRestrictedError(key: string): string {
  return `Key '${key}' is read only by the API server and can never be exported to agent env; store it with exportToEnv: false.`;
}

/** The flag readers act on: a stored true never wins for a restricted key. */
export function effectiveExportToEnv(key: string, stored: boolean): boolean {
  return stored && !isEnvExportRestrictedKey(key);
}
