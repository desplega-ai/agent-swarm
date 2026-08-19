import { parseEnvFlag } from "./env-flag";

/**
 * Opt-in, default off: allows one logical agent to be served by several
 * worker processes. Lives outside `src/be` so worker-side code can import it
 * without crossing the DB boundary.
 */
export function isMultiRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.MULTI_RUNTIME_ENABLED, false);
}
