/**
 * Shared constants used across worker- and server-side code.
 */

import { isEnvFlagEnabled, parseEnvFlag } from "./env-flag";

/** Maximum profile-file length in JavaScript characters (not UTF-8 bytes). */
export const MAX_PROFILE_FILE_LENGTH = 256 * 1024;

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

/** Where people-facing agent-fs file links point: Comb in the dashboard, or the live app. */
export type AgentFsLinkTarget = "dashboard" | "live";

/**
 * The operator's `AGENT_FS_LINK_TARGET` choice (trimmed, lowercased). Null when
 * unset, blank, or invalid: every surface then keeps its automatic behavior.
 */
export function readAgentFsLinkTarget(): AgentFsLinkTarget | null {
  const raw = process.env.AGENT_FS_LINK_TARGET?.trim().toLowerCase();
  return raw === "dashboard" || raw === "live" ? raw : null;
}

/**
 * The base URL (no trailing slash) that a people-facing file link starts with,
 * per {@link readAgentFsLinkTarget}. `dashboard` uses `APP_URL` when one is
 * configured (and, for attachments, Comb is on), else the live app. Null when
 * no target is set: the caller keeps its current code path.
 *
 * The prompt surface skips the Comb check: workers do not get `COMB_ENABLED`,
 * and an explicit `dashboard` is the operator's choice.
 */
export function resolveAgentFsLinkBase(surface: "prompt" | "attachment"): string | null {
  const target = readAgentFsLinkTarget();
  if (target === null) return null;
  if (target === "dashboard" && getConfiguredAppUrls().length > 0) {
    if (surface === "prompt" || isCombEnabled()) return getAppUrl();
  }
  return getAgentFsLiveUrl();
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

/** An agent-fs file for a link: its path plus an optional org/drive pair. */
export interface AgentFsFileRef {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
}

/** A "." or ".." path segment, raw or encoded (`%2e`). */
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;

/**
 * `<orgId>/<driveId>/<encoded-path>` for an agent-fs file link, when we have
 * enough info: `path` plus a matched `orgId`/`driveId` pair. When a row
 * supplies neither ID, the pair may come from env-var defaults. A partial row
 * never mixes its ID with a default. A "." or ".." segment returns null: the
 * browser would resolve it to a path outside the drive.
 */
export function agentFsFileRoute(opts: AgentFsFileRef): string | null {
  const path = opts.path?.trim();
  if (!path) return null;
  const rowOrgId = opts.orgId?.trim();
  const rowDriveId = opts.driveId?.trim();
  const hasRowId = Boolean(rowOrgId || rowDriveId);
  const orgId = hasRowId ? rowOrgId : getAgentFsDefaultOrgId();
  const driveId = hasRowId ? rowDriveId : getAgentFsDefaultDriveId();
  if (!orgId || !driveId) return null;
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.some((segment) => DOT_SEGMENT_RE.test(segment))) return null;
  // Never double-encode an already-encoded segment: preserve existing %HH
  // escapes byte-for-byte, including in segments that also contain raw text.
  const encodedPath = segments
    .map((segment) => encodeURIComponent(segment).replace(/%25([0-9a-f]{2})/gi, "%$1"))
    .join("/");
  return `${orgId}/${driveId}/${encodedPath}`;
}

/**
 * Resolve a public agent-fs live URL for an attachment (see
 * {@link agentFsFileRoute} for the id, dot-segment, and encoding rules). Null
 * when that route is null; callers fall back to the raw `agent-fs:<path>`
 * display instead.
 *
 * Shape:  ${liveHost}/file/~/<orgId>/<driveId>/<normalized-path>
 */
export function buildAgentFsLiveUrl(opts: AgentFsFileRef): string | null {
  const route = agentFsFileRoute(opts);
  return route ? `${getAgentFsLiveUrl()}/file/~/${route}` : null;
}

/** RFC 1918 private and 169.254/16 link-local IPv4 space, by its first two octets. */
function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * The eight 16-bit groups of an IPv6 literal (no brackets), or null when it is
 * malformed. `new URL` already normalizes a host to compressed hex, so a
 * dotted IPv4 tail never reaches here; one is rejected rather than parsed.
 */
function parseIpv6(addr: string): number[] | null {
  if (addr.includes(".")) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part
      .split(":")
      .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = toGroups(halves[0] ?? "");
  const tail = toGroups(halves[1] ?? "");
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? null : [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Whether a browser can plausibly open this URL. False for the addresses only
 * the swarm's own network resolves: a single-label host (a docker or compose
 * service such as `agent-fs`), `*.internal` (Railway, Fly, GCP),
 * `*.svc` / `*.cluster.local` (Kubernetes), and private, link-local or
 * unique-local IPs, including IPv4-mapped IPv6 (`::ffff:10.0.0.5`), `::` and
 * multicast `ff00::/8`. Loopback counts as reachable: a localhost URL means the
 * API and agent-fs share a host, which only works for a browser on that same
 * machine (the local dev setup), and a remote operator can set `COMB_ENABLED`.
 * An unparseable value is not reachable.
 */
export function isBrowserReachableUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[")) {
    const parsed = parseIpv6(host.slice(1, -1));
    if (!parsed) return false;
    const g = (i: number) => parsed[i] ?? 0;
    // Loopback is reachable (the local dev setup).
    if (parsed.slice(0, 7).every((x) => x === 0) && g(7) === 1) return true;
    // `::` and multicast `ff00::/8` are not addresses a browser can open.
    if (parsed.every((x) => x === 0) || (g(0) & 0xff00) === 0xff00) return false;
    // Unique-local `fc00::/7` and link-local `fe80::/10`.
    if ((g(0) & 0xfe00) === 0xfc00 || (g(0) & 0xffc0) === 0xfe80) return false;
    // IPv4-mapped `::ffff:a.b.c.d`: judge the embedded IPv4 address.
    if (parsed.slice(0, 5).every((x) => x === 0) && g(5) === 0xffff) {
      const a = g(6) >> 8;
      return a === 127 || !isPrivateIpv4(a, g(6) & 0xff);
    }
    return true;
  }
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return a === 127 || !isPrivateIpv4(a, b);
  }
  if (!host.includes(".")) return false;
  return !(host.endsWith(".internal") || host.endsWith(".svc") || host.endsWith(".cluster.local"));
}

export interface CombState {
  enabled: boolean;
  /** An explicit `COMB_ENABLED` decided it; otherwise the unset default did. */
  explicit: boolean;
  /** What is missing, for `/status` `agent_fs.comb.reason`. Null when Comb is on. */
  reason: string | null;
}

/**
 * Comb (the agent-fs review space in the dashboard). An explicit
 * `COMB_ENABLED` wins both ways, but still needs `AGENT_FS_API_URL`. Unset, it
 * is on only when a browser can reach agent-fs: `AGENT_FS_PUBLIC_URL` is set,
 * `AGENT_FS_PROXY` is on and the public API URL is {@link isBrowserReachableUrl}
 * (the browser goes through the API), or, with no proxy, `AGENT_FS_API_URL` is
 * itself reachable. Otherwise the browser would land on a private host.
 * Reads `process.env` per call, so a config reload applies without a restart.
 */
export function getCombState(): CombState {
  const apiUrl = process.env.AGENT_FS_API_URL?.trim().replace(/\/+$/, "");
  const raw = process.env.COMB_ENABLED;
  // The two parses agree only when the value is a recognized flag literal.
  const explicit = parseEnvFlag(raw, true) === parseEnvFlag(raw, false);
  if (explicit && !isEnvFlagEnabled("COMB_ENABLED", false)) {
    return { enabled: false, explicit, reason: "COMB_ENABLED is false." };
  }
  if (!apiUrl) return { enabled: false, explicit, reason: "AGENT_FS_API_URL is not set." };
  if (explicit) return { enabled: true, explicit, reason: null };
  if (process.env.AGENT_FS_PUBLIC_URL?.trim()) return { enabled: true, explicit, reason: null };
  // With the proxy on, the browser goes to `<public API URL>/agentfs`, so that
  // is the address to check, not `AGENT_FS_API_URL`.
  const proxy = isAgentFsProxyEnabled();
  const browserUrl = proxy ? getPublicMcpBaseUrl() : apiUrl;
  return isBrowserReachableUrl(browserUrl)
    ? { enabled: true, explicit, reason: null }
    : {
        enabled: false,
        explicit,
        reason: proxy
          ? `AGENT_FS_PROXY is on, but the API address ${browserUrl} is not reachable from a browser. Set PUBLIC_MCP_BASE_URL to the public API URL, or set COMB_ENABLED=true to force Files on.`
          : `AGENT_FS_API_URL (${apiUrl}) is not reachable from a browser. Set AGENT_FS_PUBLIC_URL or AGENT_FS_PROXY=true, or set COMB_ENABLED=true to force Files on.`,
      };
}

/**
 * Comb is on: see {@link getCombState}. `getCombConfig()` (`src/comb/config.ts`)
 * reports it.
 */
export function isCombEnabled(): boolean {
  return getCombState().enabled;
}

/**
 * `AGENT_FS_PROXY`: the API serves agent-fs at `/agentfs/*` (plus the public
 * `/share/*` and `/site/*` pages), and Comb uses `<public API URL>/agentfs`.
 * Read per request, so a config upsert applies without a restart. Off by default.
 */
export function isAgentFsProxyEnabled(): boolean {
  return isEnvFlagEnabled("AGENT_FS_PROXY", false);
}

/**
 * The dashboard (Comb) URL for an agent-fs file, same id and encoding rules as
 * {@link buildAgentFsLiveUrl}. Null unless Comb is on AND an explicit
 * `APP_URL` / `DASHBOARD_URL` is set: the hosted default dashboard cannot open
 * a self-hosted swarm's files.
 *
 * Shape:  ${appUrl}/file/~/<orgId>/<driveId>/<normalized-path>
 */
export function buildCombFileUrl(opts: AgentFsFileRef): string | null {
  if (!isCombEnabled() || getConfiguredAppUrls().length === 0) return null;
  const route = agentFsFileRoute(opts);
  return route ? `${getAppUrl()}/file/~/${route}` : null;
}
