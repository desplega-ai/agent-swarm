// What a link in task or session content previews in the side panel: one
// agent-fs file or one swarm Page (a task opens there from a card's Open
// toast, never from a link). Folders, other dashboard routes, GitHub and
// share links keep their normal behavior.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { combPathForLink } from "./comb/links";
import type { DrivePath } from "./comb/paths";
import { pageFrameQuery } from "./page-query";
import { parseSwarmLink, type SwarmLinkOrigins } from "./swarm-links";

export type LinkPreviewTarget =
  /**
   * `route` is the Comb route, with the link's `?comment=` deep link when it
   * has one; `href` is the link as written.
   */
  | { kind: "file"; file: DrivePath; name: string; route: string; href: string }
  /**
   * `id` is the page id or slug, as the link names it. `query` is the link's
   * query minus the params the page route owns (`pageFrameQuery`), or "".
   */
  | { kind: "page"; id: string; query: string; href: string }
  /** A task, opened by a card's Open toast. No link parses to it. */
  | { kind: "task"; taskId: string };

/** A drive path from a Comb route (`/file/~/<org>/<drive>/<names>`) that `comb/links` built. */
function driveFileFromRoute(route: string): DrivePath | null {
  const [, file, tilde, orgId, driveId, ...names] = (route.split("?")[0] ?? "").split("/");
  if (file !== "file" || tilde !== "~" || !orgId || !driveId || names.length === 0) return null;
  // `comb/links` encoded each checked name once with encodeURIComponent.
  return { orgId, driveId, path: `/${names.map(decodeURIComponent).join("/")}` };
}

/** The preview target of a link, or null when the link should behave as usual. */
export function linkPreviewTarget(
  href: string | null | undefined,
  origins: SwarmLinkOrigins,
): LinkPreviewTarget | null {
  if (!href) return null;
  const link = parseSwarmLink(href, origins);
  if (!link) return null;
  if (link.type === "file") {
    if (link.folder) return null;
    const route = combPathForLink(link.href, {
      liveUrl: origins.agentFsLive,
      appOrigin: new URL(link.href, origins.dashboard).origin,
    });
    const file = route ? driveFileFromRoute(route) : null;
    if (!route || !file) return null;
    return { kind: "file", file, name: link.name, route, href };
  }
  if (link.type === "dashboard" && link.route === "pages") {
    const query = pageFrameQuery(new URL(link.path, origins.dashboard).searchParams);
    return { kind: "page", id: link.id, query, href };
  }
  return null;
}

/**
 * The preview panel's "Open in new tab" link. A file opens in Comb while
 * agent-fs is connected (keeping a `?comment=` deep link), else as written.
 * A page opens on its route by id once resolved (`pageId`), with the query
 * the link forwards, so the tab shows the same view as the preview.
 */
export function linkPreviewOpenHref(
  target: LinkPreviewTarget,
  opts: { connected?: boolean; pageId?: string | null } = {},
): string {
  if (target.kind === "file") return opts.connected ? target.route : target.href;
  if (target.kind === "task") return `/tasks/${encodeURIComponent(target.taskId)}`;
  return `/pages/${encodeURIComponent(opts.pageId ?? target.id)}${target.query}`;
}

/**
 * A plain primary click: no modifier and the main button. Cmd, ctrl, shift,
 * alt and middle clicks keep the browser's link behavior (a new tab or window).
 */
export function isPlainClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}
