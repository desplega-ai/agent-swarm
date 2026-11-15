// Links in agent output that name something of this swarm: a dashboard page
// (a task, a session, a page, ...), an agent-fs file, or a GitHub PR, issue,
// commit or repo. Markdown renders them as chips
// (`components/shared/markdown-link-chip.tsx`), and so do app link cells.
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
  /** The GitHub web base (`/status` `github.web_url`). Default `https://github.com`. */
  github?: string | null;
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

/** What a GitHub link points at. `ref` is a bare `owner/repo#N`, which GitHub resolves to a PR or an issue. */
export type GithubKind = "pull" | "issue" | "commit" | "repo" | "ref";

export type SwarmLink =
  /** `number` is set for pull / issue / ref, `sha` for commit. `href` is the GitHub URL. */
  | {
      type: "github";
      kind: GithubKind;
      owner: string;
      repo: string;
      number: number | null;
      sha: string | null;
      href: string;
    }
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

export const DEFAULT_GITHUB_WEB_URL = "https://github.com";
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** The origin of a GitHub web base, github.com when it is unset or not a URL. */
export function githubOrigin(webUrl: string | null | undefined): string {
  return originOf(webUrl ?? null) ?? DEFAULT_GITHUB_WEB_URL;
}

/** The host (with port) of a GitHub web base, `github.com` by default. */
export function githubHostOf(webUrl: string | null | undefined): string {
  return new URL(githubOrigin(webUrl)).host;
}

/** True when `url` is on the GitHub web base: github.com (and www.) by default, else that host. */
export function isGithubHost(url: URL, webUrl: string | null | undefined): boolean {
  const host = githubHostOf(webUrl);
  if (host === "github.com") return GITHUB_HOSTS.has(url.hostname.toLowerCase());
  return url.host.toLowerCase() === host;
}
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;
/** First path segments that are GitHub pages, not an owner. */
const GITHUB_RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

function githubLink(
  kind: GithubKind,
  owner: string,
  repo: string,
  rest: { number?: number; sha?: string },
  href: string,
): SwarmLink | null {
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return null;
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  if (GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  return {
    type: "github",
    kind,
    owner,
    repo: repo.replace(/\.git$/, ""),
    number: rest.number ?? null,
    sha: rest.sha ?? null,
    href,
  };
}

/** A GitHub PR, issue, commit or repo URL. Any other GitHub page is not a smart link. */
function parseGithubUrl(
  url: URL,
  href: string,
  webUrl: string | null | undefined,
): SwarmLink | null {
  if (!isGithubHost(url, webUrl)) return null;
  const [owner, repo, section, id] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  if (!section) return githubLink("repo", owner, repo, {}, href);
  if ((section === "pull" || section === "issues") && id && /^\d{1,9}$/.test(id)) {
    return githubLink(
      section === "pull" ? "pull" : "issue",
      owner,
      repo,
      { number: Number(id) },
      href,
    );
  }
  if (section === "commit" && id && /^[0-9a-f]{7,40}$/i.test(id)) {
    return githubLink("commit", owner, repo, { sha: id.toLowerCase() }, href);
  }
  return null;
}

/**
 * `owner/repo#N` (a PR or an issue) and `owner/repo@<sha>` (a commit), the
 * shorthand an agent or a data column writes instead of a URL. Null for any
 * other text, so a path like `src/foo#1` is only matched when it has the exact
 * owner/repo shape.
 */
export function parseGithubShorthand(
  raw: string,
  webUrl: string | null = DEFAULT_GITHUB_WEB_URL,
): SwarmLink | null {
  const text = raw.trim();
  const base = githubOrigin(webUrl);
  const ref = /^([\w.-]+)\/([\w.-]+)#(\d{1,9})$/.exec(text);
  if (ref) {
    const [, owner = "", repo = "", n = ""] = ref;
    return githubLink(
      "ref",
      owner,
      repo,
      { number: Number(n) },
      `${base}/${owner}/${repo}/issues/${n}`,
    );
  }
  const commit = /^([\w.-]+)\/([\w.-]+)@([0-9a-f]{7,40})$/i.exec(text);
  if (commit) {
    const [, owner = "", repo = "", sha = ""] = commit;
    return githubLink(
      "commit",
      owner,
      repo,
      { sha: sha.toLowerCase() },
      `${base}/${owner}/${repo}/commit/${sha.toLowerCase()}`,
    );
  }
  return null;
}

/** The short chip label of a GitHub link: `agent-swarm#2605`, `agent-swarm@a1b2c3d`, or `owner/repo`. */
export function githubLabel(link: Extract<SwarmLink, { type: "github" }>): string {
  if (link.kind === "commit") return `${link.repo}@${(link.sha ?? "").slice(0, 7)}`;
  if (link.kind === "repo") return `${link.owner}/${link.repo}`;
  return `${link.repo}#${link.number}`;
}

/** The hover text of a GitHub link: the full `owner/repo#N`. */
export function githubTitle(link: Extract<SwarmLink, { type: "github" }>): string {
  if (link.kind === "commit") return `${link.owner}/${link.repo}@${link.sha}`;
  if (link.kind === "repo") return `${link.owner}/${link.repo}`;
  const noun = link.kind === "pull" ? "PR " : link.kind === "issue" ? "Issue " : "";
  return `${noun}${link.owner}/${link.repo}#${link.number}`;
}

/**
 * What a table cell, a detail field or a card field holds: a link (URL) or
 * the GitHub shorthand. Null for anything else, so the caller falls back to
 * plain text.
 */
export function parseSwarmLinkOrRef(raw: string, origins: SwarmLinkOrigins): SwarmLink | null {
  return parseGithubShorthand(raw, origins.github ?? null) ?? parseSwarmLink(raw, origins);
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

  const github = parseGithubUrl(url, href, origins.github);
  if (github) return github;

  const agentFs = [originOf(origins.agentFsLive), originOf(origins.agentFsApi)];
  if (!agentFs.includes(url.origin)) return null;
  // The API can sit under a path prefix, so the share route only has to end the path.
  const share = /\/share\/[^/]+(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!share) return null;
  const name = url.searchParams.get("name") || (share[1] ? decode(share[1]) : null);
  return { type: "share", name, href };
}
