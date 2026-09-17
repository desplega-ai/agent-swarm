import { parseEnvFlag } from "./env-flag";

/**
 * Worker-safe steering flag reader. Keep this outside `src/be` so
 * commands, tools, and providers can use it without crossing the DB boundary.
 *
 * Steering is enabled by default. Operators can opt out with
 * `STEERING_ENABLED=false|0`.
 */
export function isSteeringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.STEERING_ENABLED, true);
}
