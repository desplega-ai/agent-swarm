/**
 * Worker-safe steering kill-switch reader. Keep this outside `src/be` so
 * commands, tools, and providers can use it without crossing the DB boundary.
 */
export function isSteeringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const disabled = env.STEERING_DISABLE;
  return disabled !== "true" && disabled !== "1";
}
