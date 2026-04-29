/**
 * Shared constants used across worker- and server-side code.
 */

/**
 * Default dashboard URL used when `APP_URL` is unset. Points at the public
 * production dashboard so links (Slack messages, approval URLs, etc.) are
 * always renderable. Self-hosted operators should set `APP_URL` to override.
 */
export const DEFAULT_APP_URL = "https://app.agent-swarm.dev";

/**
 * Resolve the effective app/dashboard URL from `APP_URL` (with trailing
 * slashes stripped), falling back to {@link DEFAULT_APP_URL}.
 */
export function getAppUrl(): string {
  const raw = process.env.APP_URL?.trim();
  return (raw || DEFAULT_APP_URL).replace(/\/+$/, "");
}
