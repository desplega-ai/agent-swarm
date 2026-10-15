import { CREDENTIAL_POOL_VARS } from "./credentials";

/**
 * Secret swarm_config rows a harness or its tools still read from their own
 * environment. Everything else marked secret stays out of the worker process
 * env and every harness env, so `env`, `printenv`, and `/proc/<pid>/environ`
 * from an agent shell no longer list it. Agents that need another secret read
 * it on demand (get-config) or through a script credential binding.
 *
 * Keep in sync with `HARNESS_SECRET_ENV_ALLOWLIST` in docker-entrypoint.sh
 * (asserted by src/tests/harness-env-secrets.test.ts).
 */
export const HARNESS_SECRET_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Harness credentials: credential pools and every provider's own auth var.
  ...CREDENTIAL_POOL_VARS,
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  // gh, glab, az, and the git credential helpers read these at call time.
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "AZURE_DEVOPS_TOKEN",
  // The agent's own agent-scoped agent-fs key, read by the agent-fs CLI.
  "AGENT_FS_API_KEY",
]);

/** Comma-separated secret keys an operator lets through anyway; `*` keeps every secret. */
export const HARNESS_ENV_SECRET_PASSTHROUGH_KEY = "HARNESS_ENV_SECRET_PASSTHROUGH";

export function parseSecretPassthrough(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

/** Whether a secret config row may be copied into the worker and harness env. */
export function isSecretInheritable(key: string, passthrough: ReadonlySet<string>): boolean {
  return passthrough.has("*") || passthrough.has(key) || HARNESS_SECRET_ENV_ALLOWLIST.has(key);
}
