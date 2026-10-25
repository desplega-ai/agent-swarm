// Rendered HTML in Comb. Pure, with relative imports only, so the root test
// runner covers it. Rules follow agent-fs `live/src/components/viewers/HtmlViewer.tsx`
// and `live/src/lib/html-view.ts` (v0.18.5).
//
// The page loads from a short site share of its folder (`/site/<token>/`), so
// its relative links (styles, images, scripts) resolve. The frame comes from
// the agent-fs origin, never the dashboard's, and the sandbox gives it an
// opaque origin on top: it cannot read the dashboard, its storage (which holds
// the swarm and agent-fs keys), or agent-fs cookies.

import { fileExtension } from "./file-kinds";

/** The `/health` feature of servers that serve folder sites. Older servers show HTML as source only. */
export const HTML_SITES_FEATURE = "html-sites";

/**
 * The frame's sandbox. Scripts, forms, popups, and dialogs run. Never add
 * `allow-same-origin` (the page would get the agent-fs origin),
 * `allow-top-navigation*` (it could move the dashboard tab),
 * `allow-popups-to-escape-sandbox` (a popup would run without the sandbox),
 * or `allow-downloads`. The live UI allows sandbox-escaping popups. Comb does
 * not: a popup keeps this sandbox, so a site that needs its own storage can
 * break in it.
 */
export const HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

/** Every attribute of the preview frame that limits the page. */
export const HTML_FRAME_POLICY = {
  sandbox: HTML_SANDBOX,
  referrerPolicy: "no-referrer",
} as const;

/**
 * Page scripts can read the site token from `location`, so the preview's share
 * lives 15 minutes. That bounds the damage if a page sends the token out.
 */
export const HTML_SITE_TTL_SECONDS = 900;
/** A cached site share with less than this left is replaced by a new one. */
export const HTML_SITE_REMINT_MS = 3 * 60_000;

/** True for a `.html` or `.htm` file name. A bare name such as "html" has no extension. */
export function isHtmlPath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? fileExtension(name) : "";
  return ext === "html" || ext === "htm";
}

/** The folder a file's site share covers: "/" for a drive-root file, "/a/b" when nested. */
export function siteFolderOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return `/${segments.join("/")}`;
}

/** True for a file at the drive root: its site share exposes the whole drive. */
export function isDriveRootFile(path: string): boolean {
  return siteFolderOf(path) === "/";
}

/**
 * The base URL of a site share (`<endpoint>/site/<token>/`), from the agent-fs
 * URL this browser uses, so it stays right behind a proxy.
 */
export function siteBaseUrl(endpoint: string, sharePath: string): string {
  const path = sharePath.endsWith("/") ? sharePath : `${sharePath}/`;
  return `${endpoint.replace(/\/+$/, "")}${path}`;
}

/**
 * The frame URL of a file inside its folder's site. Each name segment is
 * percent-encoded, so spaces, `#`, and `?` stay part of the name.
 */
export function siteFileUrl(siteBase: string, path: string): string {
  const name = path.split("/").filter(Boolean).pop() ?? "";
  return `${siteBase}${encodeURIComponent(name)}`;
}

/** Milliseconds a site share stays usable for a new preview, from `now`. */
export function siteShareFreshFor(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - HTML_SITE_REMINT_MS - now);
}
