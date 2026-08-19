import { parseEnvFlag } from "./env-flag";

/**
 * Opt-in, default off: allows one logical agent to be served by several
 * worker processes. Lives outside `src/be` so worker-side code can import it
 * without crossing the DB boundary.
 */
export function isMultiRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.MULTI_RUNTIME_ENABLED, false);
}

/**
 * Per-boot runtime identity the runner stamps into the process environment
 * before any provider session exists. Adapters read it here to send the
 * X-Runtime-Instance-ID header on the swarm MCP session — runtime identity is
 * process/auth context, never a tool argument.
 */
export function swarmRuntimeInstanceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SWARM_RUNTIME_INSTANCE_ID || undefined;
}
