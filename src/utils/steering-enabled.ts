/**
 * Worker-safe steering opt-in reader. Keep this outside `src/be` so
 * commands, tools, and providers can use it without crossing the DB boundary.
 *
 * Steering is DISABLED by default: it only turns on when the operator sets
 * `STEERING_ENABLED=true|1`.
 */
export function isSteeringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.STEERING_ENABLED;
  return enabled === "true" || enabled === "1";
}
