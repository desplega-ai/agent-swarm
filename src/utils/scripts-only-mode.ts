import { parseEnvFlag } from "./env-flag";

/**
 * Resolve the scripts-only ("code mode") MCP surface toggle.
 *
 * Precedence: an explicit deployment env var wins over the `swarm_config`
 * value, which wins over the default (off). Both sources are parsed with the
 * shared flag parser, so `1`/`0` and `true`/`false` are equivalent — the
 * dashboard writes `"true"`/`"false"`, deployment envs historically used `1`.
 */
export function resolveScriptsOnlyMode(opts: { env?: string; configValue?: string }): boolean {
  if (opts.env) return parseEnvFlag(opts.env, false);
  if (opts.configValue) return parseEnvFlag(opts.configValue, false);
  return false;
}
