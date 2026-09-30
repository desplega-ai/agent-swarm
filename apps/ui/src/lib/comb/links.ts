// agent-fs links that open in Comb instead of leaving the dashboard.
//
// Two link shapes name a drive file:
// - the agent-fs live UI: `<liveUrl>/file/~/<org>/<drive>/<path>` (or `/detail/~/`)
// - the dashboard, as the server writes it with `APP_URL`: `<origin>/file/~/...`
// Both become the Comb route `combPath()`.
//
// Keep this module dependency-free (only `./paths` and types), so shared
// renderers such as `MarkdownView` can use it without loading Comb.

import type { AgentFsState } from "../agent-fs/state";
import { combPath, type DrivePath } from "./paths";

/** A drive file or folder named by a link, plus the comment it points at. */
export interface DriveLinkTarget extends DrivePath {
  comment: string | null;
}

const LIVE_ROUTES = ["/file/~/", "/detail/~/"] as const;
const APP_ROUTES = ["/file/~/"] as const;
/** agent-fs org and drive ids (UUIDs). They go into the route unencoded. */
const ID_RE = /^[\w-]+$/;

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

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Parse `<base><route><org>/<drive>/<path>` into a drive path. Each path
 * segment is decoded once. A segment that decodes to "." or ".." or contains
 * "/" returns null, so a link cannot name a path outside the drive.
 */
export function fileUrlToDrivePath(
  url: URL,
  base: string,
  routes: readonly string[],
): DriveLinkTarget | null {
  const baseUrl = parseUrl(base);
  if (!baseUrl || url.origin !== baseUrl.origin) return null;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const route = routes.find((r) => url.pathname.startsWith(`${basePath}${r}`));
  if (route === undefined) return null;

  // The URL parser already resolved "." and ".." segments (also `%2e`), like a
  // browser. A link that climbs out of its drive lands on another id or route.
  const [orgId, driveId, ...rawPath] = url.pathname
    .slice(basePath.length + route.length)
    .split("/");
  if (!orgId || !driveId || !ID_RE.test(orgId) || !ID_RE.test(driveId)) return null;

  const segments: string[] = [];
  for (const raw of rawPath) {
    if (raw === "") continue;
    const segment = decodeSegment(raw);
    if (segment === null || segment === "." || segment === ".." || segment.includes("/")) {
      return null;
    }
    segments.push(segment);
  }
  const isFolder = rawPath.length === 0 || rawPath[rawPath.length - 1] === "";
  const body = `/${segments.join("/")}`;
  const path = segments.length === 0 ? "/" : isFolder ? `${body}/` : body;
  const comment = url.searchParams.get("comment") || null;
  return { orgId, driveId, path, comment };
}

function toCombPath(target: DriveLinkTarget | null): string | null {
  if (!target) return null;
  const { comment, ...drivePath } = target;
  const query = comment ? `?comment=${encodeURIComponent(comment)}` : "";
  return `${combPath(drivePath)}${query}`;
}

/** An absolute agent-fs live UI link as a Comb route. Null for any other URL. */
export function liveUrlToCombPath(href: string, liveUrl: string | null | undefined): string | null {
  const url = liveUrl ? parseUrl(href.trim()) : null;
  return url && liveUrl ? toCombPath(fileUrlToDrivePath(url, liveUrl, LIVE_ROUTES)) : null;
}

/**
 * A dashboard file link (absolute on `appOrigin`, or root-relative) as a
 * normalized Comb route. Null for any other URL.
 */
export function appUrlToCombPath(href: string, appOrigin: string): string | null {
  const url = parseUrl(href.trim(), appOrigin);
  return url ? toCombPath(fileUrlToDrivePath(url, appOrigin, APP_ROUTES)) : null;
}

/** The Comb route for a live UI link or a dashboard file link. Null for other links. */
export function combPathForLink(
  href: string,
  opts: { liveUrl: string | null | undefined; appOrigin: string },
): string | null {
  return liveUrlToCombPath(href, opts.liveUrl) ?? appUrlToCombPath(href, opts.appOrigin);
}
