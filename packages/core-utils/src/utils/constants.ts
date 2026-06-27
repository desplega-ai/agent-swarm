/**
 * Shared constants used across worker- and server-side code.
 */

/**
 * Default dashboard URL used when neither `APP_URL` nor the deprecated
 * `DASHBOARD_URL` is set. Points at the public production dashboard so links
 * (Slack messages, approval URLs, page share links, post-OAuth redirects)
 * stay renderable even when an operator forgets to configure it. Local dev
 * should set `APP_URL` (e.g. in `.env`) to point at the local dashboard.
 */
export const DEFAULT_APP_URL = "https://app.agent-swarm.dev";

/**
 * Resolve every explicitly configured app/dashboard URL. Each env var may be
 * a comma-separated origin list; entries are returned in precedence order with
 * trailing slashes stripped.
 *
 * Precedence: `APP_URL` entries → `DASHBOARD_URL` entries (deprecated alias,
 * kept for back-compat).
 */
export function getConfiguredAppUrls(): string[] {
  return [process.env.APP_URL, process.env.DASHBOARD_URL]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Resolve the effective app/dashboard URL — the public origin the user's
 * browser is sent to (post-login redirects, Slack/approval links, page
 * `app_url` share links). Trailing slashes are stripped.
 *
 * Precedence: first configured `APP_URL` entry → first configured
 * `DASHBOARD_URL` entry (deprecated alias, kept for back-compat) → fallback.
 * This is the single source of truth; call sites must not re-read
 * `APP_URL`/`DASHBOARD_URL` directly.
 */
export function getAppUrl(fallback = DEFAULT_APP_URL): string {
  return (getConfiguredAppUrls()[0] || fallback).replace(/\/+$/, "");
}

/**
 * Internal API/MCP base URL — how workers/agents and in-process callers reach
 * the API server. May be a private/cluster address (e.g. the Helm ClusterIP
 * `http://<release>-api:3013`). Do NOT use for browser-facing or
 * externally-registered URLs (OAuth redirect URIs, webhook URLs): those must
 * resolve to a host the browser / third party can reach — use
 * {@link getPublicMcpBaseUrl} (no request context) or `deriveApiBaseUrl(req)`
 * (request-scoped) instead. Trailing slashes are stripped.
 */
export function getMcpBaseUrl(): string {
  const raw = process.env.MCP_BASE_URL?.trim();
  return (raw || `http://localhost:${process.env.PORT || "3013"}`).replace(/\/+$/, "");
}

/**
 * Public, browser-/externally-reachable origin of the API server — where
 * `/api/mcp-oauth/callback`, OAuth redirect URIs, and registered webhook URLs
 * resolve. Falls back to {@link getMcpBaseUrl} when the public and internal
 * hosts are the same (local dev, single-box, or an ngrok/tunnel set as
 * `MCP_BASE_URL`). In split deployments (Helm), set `PUBLIC_MCP_BASE_URL` to
 * the public ingress URL while `MCP_BASE_URL` stays the internal service
 * address. Trailing slashes are stripped.
 */
export function getPublicMcpBaseUrl(): string {
  const raw = process.env.PUBLIC_MCP_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : getMcpBaseUrl();
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

/**
 * Optional fallback agent-fs `org_id` for attachments that store only `path`.
 * Strictly opt-in — when neither env var is set, the renderer keeps the
 * `agent-fs:<path>` raw-string fallback. Row-level IDs always win over the
 * env-var defaults so per-attachment overrides remain authoritative.
 */
export function getAgentFsDefaultOrgId(): string | undefined {
  const raw = process.env.AGENT_FS_DEFAULT_ORG_ID?.trim();
  return raw || undefined;
}

/**
 * Optional fallback agent-fs `drive_id`. See {@link getAgentFsDefaultOrgId}.
 */
export function getAgentFsDefaultDriveId(): string | undefined {
  const raw = process.env.AGENT_FS_DEFAULT_DRIVE_ID?.trim();
  return raw || undefined;
}

/**
 * Resolve a public agent-fs live URL for an attachment when we have enough
 * info — `path` plus (`orgId` and `driveId`, falling back to env-var
 * defaults). Returns `null` when the path is missing or no org/drive pair is
 * available; callers fall back to the raw `agent-fs:<path>` display.
 *
 * Shape:  ${liveHost}/file/~/<orgId>/<driveId>/<normalized-path>
 */
export function buildAgentFsLiveUrl(opts: {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
}): string | null {
  const path = opts.path?.trim();
  if (!path) return null;
  const orgId = opts.orgId?.trim() || getAgentFsDefaultOrgId();
  const driveId = opts.driveId?.trim() || getAgentFsDefaultDriveId();
  if (!orgId || !driveId) return null;
  const host = getAgentFsLiveUrl();
  const normalizedPath = path.replace(/^\/+/, "");
  return `${host}/file/~/${orgId}/${driveId}/${normalizedPath}`;
}
