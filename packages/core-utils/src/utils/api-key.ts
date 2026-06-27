/**
 * Centralized resolution of the swarm API key from the environment.
 *
 * Precedence:
 *   1. AGENT_SWARM_API_KEY  (preferred — namespaced, safe to set globally)
 *   2. API_KEY              (legacy — kept for back-compat with existing setups)
 *
 * All swarm code (CLI, server, hooks, worker, scripts) must read the key via
 * `getApiKey()` so a user can configure either env var and have it work end
 * to end. Direct access to `process.env.API_KEY` / `process.env.AGENT_SWARM_API_KEY`
 * outside this module is enforced against by `scripts/check-api-key-boundary.sh`.
 */

type EnvLike = Record<string, string | undefined>;

export function getApiKey(env: EnvLike = process.env): string {
  return env.AGENT_SWARM_API_KEY ?? env.API_KEY ?? "";
}

/**
 * Mirror a resolved key onto both env var names so any downstream code that
 * still reads the raw env (third-party libraries, spawned subprocesses that
 * inherit env, etc.) sees a consistent value.
 */
export function setApiKey(key: string, env: EnvLike = process.env): void {
  env.AGENT_SWARM_API_KEY = key;
  env.API_KEY = key;
}
