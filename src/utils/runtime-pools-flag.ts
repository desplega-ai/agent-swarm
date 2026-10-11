import { isEnvFlagEnabled } from "./env-flag";

/**
 * `RUNTIME_POOLS_ENABLED` (default off) gates the whole push-workers feature:
 * the runtime supervisor, pool routing, worker nudges, the pool/controller
 * routes and tools, and the dashboard pages. Read it per call so a
 * `swarm_config` reload takes effect.
 */
export function isRuntimePoolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("RUNTIME_POOLS_ENABLED", false, env);
}
