import { getSwarmConfigs } from "../be/db";

/**
 * Resolve workflow input values.
 *
 * Patterns:
 *   - `${ENV_VAR}` -> process.env[ENV_VAR]
 *   - `secret.NAME` -> look up in DB config store (global scope, isSecret=true)
 *   - literal string -> pass through
 */
export function resolveInputs(input: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    resolved[key] = resolveValue(value);
  }

  return resolved;
}

function resolveValue(value: string): string {
  // Env var reference: ${MY_VAR}
  const envMatch = /^\$\{(.+)\}$/.exec(value);
  if (envMatch?.[1]) {
    const envName = envMatch[1];
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(`Environment variable "${envName}" is not set`);
    }
    return envValue;
  }

  // Secret reference: secret.NAME
  if (value.startsWith("secret.")) {
    const secretName = value.slice("secret.".length);
    const configs = getSwarmConfigs({ scope: "global", key: secretName });
    const secretConfig = configs.find((c) => c.isSecret);
    if (!secretConfig) {
      throw new Error(`Secret "${secretName}" not found in config store`);
    }
    return secretConfig.value;
  }

  // Literal
  return value;
}
