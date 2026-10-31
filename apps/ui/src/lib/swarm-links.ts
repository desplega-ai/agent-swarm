// Links in agent output that name something of this swarm: a dashboard page
// (a task, a session, a page, ...) or an agent-fs file. Markdown renders them
// as chips (`components/shared/markdown-link-chip.tsx`).
//
// No host is built in: a self-hosted swarm has its own URLs. The caller passes
// the origins the dashboard knows (`SwarmLinkOrigins`).
//
// Relative imports only: `bun:test` runs this from the repo root.

import { appUrlToCombPath, liveUrlToCombPath } from "./comb/links";

export interface SwarmLinkOrigins {
  /** The dashboard's own origin (the address bar). Root-relative links resolve against it. */
  dashboard: string;
  /**
   * The swarm's configured public dashboard (`/status` `identity.dashboard_url`).
   * Its links open the same path on this dashboard.
   */
  configuredDashboard: string | null;
  /** The agent-fs live UI (`/status` `agent_fs.comb.live_url`). */
  agentFsLive: string | null;
  /** The browser-facing agent-fs API (`agent_fs.comb.api_url`), which serves share links. */
  agentFsApi: string | null;
}

/** Dashboard routes with an id (the first path segment), and the noun a chip shows. */
export const DASHBOARD_ROUTES = {
  pages: "Page",
  tasks: "Task",
  sessions: "Session",
  apps: "App",
  workflows: "Workflow",
  "workflow-runs": "Workflow run",
  agents: "Agent",
  schedules: "Schedule",
  scripts: "Script",
  "script-runs": "Script run",
  "approval-requests": "Approval",
  skills: "Skill",
  "mcp-servers": "MCP server",
  templates: "Template",
  repos: "Repo",
  people: "Person",
} as const;

export type DashboardRoute = keyof typeof DASHBOARD_ROUTES;

export type SwarmLink =
  /** `path` is root-relative, for the router: the same path on this dashboard. */
  | { type: "dashboard"; route: DashboardRoute; id: string; path: string; href: string }
  /** `path` is the decoded drive path. */
  | { type: "file"; name: string; path: string; folder: boolean; href: string }
  | { type: "share"; name: string | null; href: string };

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function originOf(value: string | null): string | null {
  return value ? (parseUrl(value)?.origin ?? null) : null;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A drive file from its Comb route (`/file/~/<org>/<drive>/<names>`), which `comb/links` checked. */
function fileFromCombRoute(route: string, href: string): SwarmLink | null {
  const pathname = route.split("?")[0] ?? "";
  const names = pathname.split("/").slice(5).filter(Boolean).map(decode);
  const name = names.at(-1);
  if (!name) return null;
  const folder = pathname.endsWith("/");
  return { type: "file", name, path: `/${names.join("/")}${folder ? "/" : ""}`, folder, href };
}

/**
 * What a link names, or null for any other link. A Slack-style `<url|label>`
 * ends at the "|": the returned `href` is the URL alone.
 */
export function parseSwarmLink(raw: string, origins: SwarmLinkOrigins): SwarmLink | null {
  const href = (raw.split("|")[0] ?? "").trim();
  if (!/^(https?:\/\/|\/(?!\/))/i.test(href)) return null;
  const url = parseUrl(href, origins.dashboard);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  const onDashboard = [originOf(origins.dashboard), originOf(origins.configuredDashboard)].includes(
    url.origin,
  );

  // `comb/links` checks the raw href (dot segments, ids, names) before it builds a route.
  const comb =
    liveUrlToCombPath(href, origins.agentFsLive) ??
    (onDashboard ? appUrlToCombPath(href, url.origin) : null);
  if (comb) return fileFromCombRoute(comb, href);

  if (onDashboard) {
    const match = /^\/([a-z-]+)\/([^/]+)/.exec(url.pathname);
    const route = match?.[1] ?? "";
    const id = decode(match?.[2] ?? "");
    if (!Object.hasOwn(DASHBOARD_ROUTES, route) || !id || id === "new") return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    return { type: "dashboard", route: route as DashboardRoute, id, path, href };
  }

  const agentFs = [originOf(origins.agentFsLive), originOf(origins.agentFsApi)];
  if (!agentFs.includes(url.origin)) return null;
  // The API can sit under a path prefix, so the share route only has to end the path.
  const share = /\/share\/[^/]+(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!share) return null;
  const name = url.searchParams.get("name") || (share[1] ? decode(share[1]) : null);
  return { type: "share", name, href };
}
