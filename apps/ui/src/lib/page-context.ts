/**
 * Contextual session panel — derive a stable "page key" for the page the user
 * is looking at, plus the human-readable context appended to a new session.
 *
 * Page key: `task:ui:{kind}:{ref}`. Each session started from the panel gets
 * `contextKey = {pageKey}:{sessionNonce}`, and the dropdown lists earlier
 * sessions with `GET /api/sessions?contextKeyPrefix={pageKey}:`. The key is
 * per session on purpose: a page-level key would let sibling-awareness nest a
 * new session under one already running on the same page.
 *
 * The router carries no route metadata, so entity routes are matched against
 * the table below; every other page falls back to `route` with its path
 * segments joined by `.`.
 */

import { matchPath } from "react-router-dom";
import { buildContextFooter } from "../components/session-panel/model";

export interface PageContext {
  /** `task:ui:{kind}:{ref}` — never contains a nonce. */
  pageKey: string;
  kind: string;
  /** Raw (decoded) entity id, or the dotted path for `route` pages. */
  ref: string;
  /** Route pattern that matched, e.g. `/workflows/:id`; the pathname for `route` pages. */
  routePattern: string;
  url: string;
  title: string;
}

/** Order matters only where patterns overlap; the first match wins. */
const ENTITY_ROUTES: ReadonlyArray<{ pattern: string; kind: string }> = [
  { pattern: "/agents/:id", kind: "agent" },
  { pattern: "/tasks/:id", kind: "task" },
  { pattern: "/workflows/:id", kind: "workflow" },
  { pattern: "/workflow-runs/:id", kind: "workflow-run" },
  { pattern: "/schedules/:id", kind: "schedule" },
  { pattern: "/scripts/:id", kind: "script" },
  { pattern: "/script-runs/:id", kind: "script-run" },
  { pattern: "/pages/:id", kind: "page" },
  { pattern: "/apps/:id", kind: "app" },
  { pattern: "/apps/:id/p/:page", kind: "app" },
  { pattern: "/skills/:id", kind: "skill" },
  { pattern: "/templates/:id", kind: "template" },
  { pattern: "/templates/:id/history/:version", kind: "template" },
  { pattern: "/mcp-servers/:id", kind: "mcp-server" },
  { pattern: "/repos/:id", kind: "repo" },
  { pattern: "/people/:id", kind: "person" },
  { pattern: "/connections/:id", kind: "connection" },
  { pattern: "/approval-requests/:id", kind: "approval-request" },
];

/** Pages where the panel is not offered: already a session view, or pre-connection setup. */
const HIDDEN_ROUTES = ["/sessions", "/sessions/*", "/setup", "/setup/*"];

/** Static list-page segments that must not be read as an entity id. */
const RESERVED_IDS: Record<string, readonly string[]> = {
  person: ["unmapped"],
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `:` separates key parts server-side, so every embedded value is percent-encoded. */
function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function isPanelHiddenOn(pathname: string): boolean {
  return HIDDEN_ROUTES.some((pattern) => matchPath(pattern, pathname) !== null);
}

export function getPageContext(input: {
  pathname: string;
  url?: string;
  title?: string;
}): PageContext | null {
  const { pathname } = input;
  if (isPanelHiddenOn(pathname)) return null;
  const url = input.url ?? pathname;
  const title = input.title?.trim() ?? "";

  for (const { pattern, kind } of ENTITY_ROUTES) {
    const match = matchPath(pattern, pathname);
    const id = match?.params.id;
    if (!id || RESERVED_IDS[kind]?.includes(id)) continue;
    const ref = safeDecode(id);
    return {
      pageKey: `task:ui:${kind}:${keyPart(ref)}`,
      kind,
      ref,
      routePattern: pattern,
      url,
      title,
    };
  }

  const segments = pathname.split("/").filter(Boolean).map(safeDecode);
  const ref = segments.length > 0 ? segments.join(".") : "home";
  return {
    pageKey: `task:ui:route:${keyPart(ref)}`,
    kind: "route",
    ref,
    routePattern: pathname,
    url,
    title,
  };
}

/**
 * Footer appended to the root task text only. Follow-ups get it through the
 * parent-chain preamble. It sits at the end so session titles and previews
 * still start with what the user typed.
 */
export function buildPageContextFooter(ctx: PageContext): string {
  return buildContextFooter(
    [
      ["URL", ctx.url],
      ["Route", ctx.routePattern],
      ["Entity", ctx.kind !== "route" ? `${ctx.kind} ${ctx.ref}` : undefined],
      ["Title", ctx.title],
    ],
    "swarm UI",
  );
}

/** Human label for the panel header. */
export function pageContextLabel(ctx: PageContext): string {
  return ctx.kind === "route" ? ctx.routePattern : `${ctx.kind} ${ctx.ref}`;
}
