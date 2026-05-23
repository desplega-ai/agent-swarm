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

/**
 * Default agent-fs live host used when `AGENT_FS_LIVE_URL` is unset. Points at
 * the public production live server so any link rendered in Slack/UI is
 * always reachable. Self-hosted operators should set `AGENT_FS_LIVE_URL`.
 */
export const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";

/**
 * Resolve the effective agent-fs live URL from `AGENT_FS_LIVE_URL` (with
 * trailing slashes stripped), falling back to {@link DEFAULT_AGENT_FS_LIVE_URL}.
 */
export function getAgentFsLiveUrl(): string {
  const raw = process.env.AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}
