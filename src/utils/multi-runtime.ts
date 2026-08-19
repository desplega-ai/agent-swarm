import { parseEnvFlag } from "./env-flag";

/**
 * Multi-runtime opt-in reader. Kept outside `src/be` so worker-side code can
 * import it without crossing the DB boundary.
 *
 * Multi-runtime mode is DISABLED by default: it only turns on when the
 * operator sets `MULTI_RUNTIME_ENABLED=true|1`. When off, registration keeps
 * today's write-through behavior (the worker's reported concurrency lands in
 * `agents.maxTasks`) and no runtime-instance rows are written. When on,
 * registration records the reporting process as a runtime instance and the
 * logical maxTasks policy is owned by the agent-scoped AGENT_MAX_TASKS
 * swarm_config row instead of the registering runtime.
 */
export function isMultiRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.MULTI_RUNTIME_ENABLED, false);
}
