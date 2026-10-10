// agent-fs links that open in Comb instead of leaving the dashboard.
//
// Two link shapes name a drive file:
// - the agent-fs live UI: `<liveUrl>/file/~/<org>/<drive>/<path>` (or `/detail/~/`)
// - the dashboard, as the server writes it with `APP_URL`: `<origin>/file/~/...`
// Both become the Comb route `/file/~/<org>/<drive>/<path>`.
//
// Containment: a route built here never names a path outside its drive, also
// after the router decodes it again. This module builds routes itself: each
// path segment is decoded once, checked, and encoded with plain
// `encodeURIComponent`. A link returns null when:
// - its path has a dot segment (`.`, `..`, `%2e%2e`), before the URL parser
//   resolves it;
// - a segment decodes to "." or "..", or to a name with "/" or "\";
// - a second decode would do that (`%252e%252e` decodes to `%2e%2e`, then "..").
//
// Keep this module dependency-free (types only), so shared renderers such as
// `MarkdownView` can use it without loading Comb.

import type { AgentFsState } from "../agent-fs/state";
import type { DrivePath } from "./paths";

const LIVE_ROUTES = ["/file/~/", "/detail/~/"] as const;
const APP_ROUTES = ["/file/~/"] as const;
/** agent-fs org and drive ids (UUIDs). They go into the route unencoded. */
const ID_RE = /^[\w-]+$/;
/** A "." or ".." path segment in any spelling (`%2e`), ended by "/", "\", or the end. */
const DOT_SEGMENT_RE = /(?:^|[/\\])(?:\.|%2e){1,2}(?=[/\\]|$)/i;

/** Comb links open in the same tab only when the human is connected. */
export function isCombNavigable(state: AgentFsState): boolean {
  return state === "ready";
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isDriveName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
}

/** A decoded name that stays a drive name after one more decode. */
function isSafeName(name: string): boolean {
  const again = safeDecode(name);
  return isDriveName(name) && (again === null || isDriveName(again));
}

/** The Comb route for decoded drive names. Null for an unsafe id or name. */
function combRoute(
  orgId: string,
  driveId: string,
  names: readonly string[],
  isFolder: boolean,
  comment: string | null = null,
): string | null {
  if (!ID_RE.test(orgId) || !ID_RE.test(driveId) || !names.every(isSafeName)) return null;
  const trailing = isFolder && names.length > 0 ? "/" : "";
  const query = comment ? `?comment=${encodeURIComponent(comment)}` : "";
  return `/file/~/${orgId}/${driveId}/${names.map(encodeURIComponent).join("/")}${trailing}${query}`;
}

/** Decode each segment of an encoded path once. Null for a malformed or dot segment. */
function decodePath(encodedPath: string): { names: string[]; isFolder: boolean } | null {
  if (DOT_SEGMENT_RE.test(encodedPath)) return null;
  const segments = encodedPath.split("/");
  const names: string[] = [];
  for (const segment of segments) {
    if (segment === "") continue;
    const name = safeDecode(segment);
    if (name === null) return null;
    names.push(name);
  }
  return { names, isFolder: segments[segments.length - 1] === "" };
}

/** `<base><route><org>/<drive>/<path>` as a Comb route. Null for any other URL. */
function fileUrlToCombPath(
  href: string,
  base: string,
  routes: readonly string[],
  parseBase?: string,
): string | null {
  // The URL parser resolves dot segments, so check the raw path first.
  if (DOT_SEGMENT_RE.test(href.split(/[?#]/, 1)[0] ?? "")) return null;
  const url = parseUrl(href, parseBase);
  const baseUrl = parseUrl(base);
  if (!url || !baseUrl || url.origin !== baseUrl.origin) return null;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const route = routes.find((r) => url.pathname.startsWith(`${basePath}${r}`));
  if (route === undefined) return null;

  const [orgId = "", driveId = "", ...rest] = url.pathname
    .slice(basePath.length + route.length)
    .split("/");
  const path = decodePath(rest.join("/"));
  if (!path) return null;
  const comment = url.searchParams.get("comment") || null;
  return combRoute(orgId, driveId, path.names, path.isFolder, comment);
}

/** An absolute agent-fs live UI link as a Comb route. Null for any other URL. */
export function liveUrlToCombPath(href: string, liveUrl: string | null | undefined): string | null {
  return liveUrl ? fileUrlToCombPath(href.trim(), liveUrl, LIVE_ROUTES) : null;
}

/**
 * A dashboard file link as a normalized Comb route. The href must start with
 * "/" (root-relative) or with `appOrigin` (the server writes these with
 * `APP_URL`). Null for any other href, including a relative `file/~/...`.
 */
export function appUrlToCombPath(href: string, appOrigin: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") && !trimmed.startsWith(`${appOrigin}/`)) return null;
  return fileUrlToCombPath(trimmed, appOrigin, APP_ROUTES, appOrigin);
}

/** The Comb route for a live UI link or a dashboard file link. Null for other links. */
export function combPathForLink(
  href: string,
  opts: { liveUrl: string | null | undefined; appOrigin: string },
): string | null {
  return liveUrlToCombPath(href, opts.liveUrl) ?? appUrlToCombPath(href, opts.appOrigin);
}

/**
 * The Comb route for a link while Comb is connected (`ready`). Null in every
 * other state, so the link keeps its target (a new tab). While Comb is loading
 * the link stays too: a click never goes to Comb before the key is checked.
 */
export function combLinkFor(
  state: AgentFsState,
  liveUrl: string | null | undefined,
  appOrigin: string,
  href: string | null | undefined,
): string | null {
  return isCombNavigable(state) && href ? combPathForLink(href, { liveUrl, appOrigin }) : null;
}

/**
 * The Comb route for a drive file given as ids plus a URL-encoded path (the
 * path part of a live URL, as an attachment row builds it). Same rules as a link.
 */
export function encodedPathToCombPath(file: {
  orgId: string;
  driveId: string;
  encodedPath: string;
}): string | null {
  const path = decodePath(file.encodedPath);
  return path ? combRoute(file.orgId, file.driveId, path.names, path.isFolder) : null;
}

/**
 * The agent-fs live UI URL for a drive path (decoded names, as the Comb route
 * gives them). The live UI uses the same `/file/~/` scheme. Null when an id or
 * a name is unsafe, so "Open in agent-fs" never leaves the drive.
 */
export function drivePathToLiveUrl(target: DrivePath, liveUrl: string): string | null {
  const names = target.path.split("/").filter(Boolean);
  const route = combRoute(target.orgId, target.driveId, names, target.path.endsWith("/"));
  return route ? `${liveUrl.replace(/\/+$/, "")}${route}` : null;
}
