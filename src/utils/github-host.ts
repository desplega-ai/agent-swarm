/**
 * GitHub host resolver: one place that owns the web, REST and GraphQL bases.
 *
 * `GITHUB_URL` (web base, default https://github.com) and `GITHUB_API_URL`
 * (REST override) target a GitHub Enterprise Server instance. Both are
 * deployment-env only (reserved in swarm-config-guard): the API base receives
 * the PAT, the App JWT and installation tokens.
 *
 * Env is read on every call (no cache) so tests and config reloads both work.
 * No DB imports: API and worker code both use this module.
 */

const DEFAULT_WEB_URL = "https://github.com";
const DEFAULT_API_URL = "https://api.github.com";
/** Hosts the SQL helpers can splice into a string literal or GLOB pattern. */
const SQL_SAFE_HOST = /^[a-z0-9._:-]+$/;

export interface GitHubHostConfig {
  /** Web base, no trailing slash, e.g. `https://ghe.corp`. */
  webUrl: string;
  /** REST base, no trailing slash, e.g. `https://ghe.corp/api/v3`. */
  apiUrl: string;
  graphqlUrl: string;
  /** Host (with port when set) for git/gh, e.g. `ghe.corp`. */
  host: string;
  /** Host (with port) of the REST base, e.g. `api.github.com`. */
  apiHost: string;
  enterprise: boolean;
}

export type GitHubHostResult =
  | { ok: true; config: GitHubHostConfig; warning?: string }
  | { ok: false; error: string };

type Env = Record<string, string | undefined>;

const DEFAULT_CONFIG: GitHubHostConfig = {
  webUrl: DEFAULT_WEB_URL,
  apiUrl: DEFAULT_API_URL,
  graphqlUrl: `${DEFAULT_API_URL}/graphql`,
  host: "github.com",
  apiHost: "api.github.com",
  enterprise: false,
};

// Error messages never echo the raw value or its path: either can carry a token
// (`https://user:ghp_x@host`, `https://host/ghp_x`), and they reach boot logs and /status.

function parseBase(name: string, raw: string, allowPath: boolean): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${name} is not a valid URL`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${name} must use https:// (got ${url.protocol})`;
  }
  if (url.username || url.password) return `${name} must not contain credentials`;
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    return `${name} must not contain a query or fragment`;
  }
  if (!allowPath && url.pathname !== "/") {
    return `${name} must be the instance root, without a path`;
  }
  if (!SQL_SAFE_HOST.test(url.host)) {
    // shortcut: IPv6 literals (`[::1]`) are refused because `[` is a GLOB class, upgrade by escaping if one is needed.
    return `${name} host must be a DNS name or IPv4 address`;
  }
  return url;
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Resolve and validate the GitHub host config from env. Never throws. */
export function resolveGitHubHost(env: Env = process.env): GitHubHostResult {
  const rawWeb = env.GITHUB_URL?.trim() ?? "";
  const rawApi = env.GITHUB_API_URL?.trim() ?? "";
  const warnings: string[] = [];

  let webUrl = DEFAULT_WEB_URL;
  let host = "github.com";
  if (rawWeb) {
    const parsed = parseBase("GITHUB_URL", rawWeb, false);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    if (parsed.protocol === "http:")
      warnings.push("GITHUB_URL uses http://; tokens travel unencrypted");
    // URL lowercases the host already; `origin` drops the trailing slash.
    webUrl = parsed.origin;
    host = parsed.host;
  }

  // An explicit github.com (or www.) is the default, whatever the scheme.
  const enterprise = host !== "github.com" && host !== "www.github.com";
  if (!enterprise) {
    webUrl = DEFAULT_WEB_URL;
    host = "github.com";
    warnings.length = 0;
  }

  let apiUrl: string;
  if (rawApi) {
    const parsed = parseBase("GITHUB_API_URL", rawApi, true);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    if (parsed.protocol === "http:")
      warnings.push("GITHUB_API_URL uses http://; tokens travel unencrypted");
    apiUrl = stripSlash(`${parsed.origin}${parsed.pathname}`);
  } else if (!enterprise) {
    apiUrl = DEFAULT_API_URL;
  } else if (host.endsWith(".ghe.com")) {
    // GHE.com data residency: the API lives on an `api.` subdomain.
    apiUrl = `${webUrl.replace("://", "://api.")}`;
  } else {
    apiUrl = `${webUrl}/api/v3`;
  }

  const graphqlUrl = apiUrl.endsWith("/api/v3")
    ? `${apiUrl.slice(0, -"/api/v3".length)}/api/graphql`
    : `${apiUrl}/graphql`;

  return {
    ok: true,
    config: { webUrl, apiUrl, graphqlUrl, host, apiHost: new URL(apiUrl).host, enterprise },
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  };
}

/**
 * The resolved config. Throws on an invalid value rather than falling back to github.com.
 * For readers that pick where a token goes; parse/link readers use getGitHubLinkConfig.
 */
export function getGitHubHostConfig(): GitHubHostConfig {
  const result = resolveGitHubHost();
  if (!result.ok) throw new Error(`Invalid GitHub host config: ${result.error}`);
  return result.config;
}

/**
 * The resolved config, or the github.com default when the config is invalid. Never throws.
 * Only for readers that parse or link (PR extraction, SQL host match, citations, presets,
 * VCS detection); never use it to pick where a token goes.
 */
export function getGitHubLinkConfig(): GitHubHostConfig {
  const result = resolveGitHubHost();
  return result.ok ? result.config : { ...DEFAULT_CONFIG };
}

export const getGitHubWebUrl = (): string => getGitHubHostConfig().webUrl;
export const getGitHubApiUrl = (): string => getGitHubHostConfig().apiUrl;
export const getGitHubGraphqlUrl = (): string => getGitHubHostConfig().graphqlUrl;
export const getGitHubHost = (): string => getGitHubHostConfig().host;
export const isGitHubEnterprise = (): boolean => getGitHubHostConfig().enterprise;

/** `${apiBase}${path}`, path starting with `/`. */
export function githubApiUrl(path: string): string {
  return `${getGitHubApiUrl()}${path}`;
}

/** `${webBase}${path}`, path starting with `/`. */
export function githubWebLink(path: string): string {
  return `${getGitHubWebUrl()}${path}`;
}

/**
 * The configured host (github.com on an invalid config), safe to splice into a SQL
 * string literal or GLOB pattern: resolveGitHubHost refuses any other host shape. Never throws.
 */
export function getGitHubHostForSql(): string {
  const host = getGitHubLinkConfig().host;
  return SQL_SAFE_HOST.test(host) ? host : DEFAULT_CONFIG.host;
}

/**
 * Host of a URL (https://, git://, ssh:// or scp-like `git@host:owner/repo`),
 * lowercased, or null.
 */
function urlHost(url: string): string | null {
  const scp = url.match(/^[\w.-]+@([^:/]+):(?!\/)/);
  if (scp) return scp[1]!.toLowerCase();
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `url` points at the configured GitHub host (plus www.github.com in default mode).
 * Parse-only: github.com rules on an invalid config. Never throws.
 */
export function isGitHubUrl(url: string): boolean {
  const host = urlHost(url.trim());
  if (!host) return false;
  const config = getGitHubLinkConfig();
  if (host === config.host) return true;
  // scp-like and ssh URLs never carry the web port.
  if (host === new URL(config.webUrl).hostname) return true;
  return !config.enterprise && host === "www.github.com";
}
