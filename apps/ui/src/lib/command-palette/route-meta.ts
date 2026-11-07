/**
 * Cmd+K metadata that lives on each route's `handle`, and the checks that keep
 * it complete. A shipped page shows up in the palette because its route says
 * so, not because someone remembered a second list. `routes.test.ts` fails
 * when a route has neither metadata nor an explicit opt-out.
 *
 * No `@/` imports: the route guard test loads this file under `bun test`,
 * which cannot resolve the alias.
 */
import type { LucideIcon } from "lucide-react";
import type { RouteObject } from "react-router-dom";

/**
 * Every searchable entity type, in the order the palette shows their groups.
 * Each id has one provider in `components/command-palette/providers.tsx`.
 */
export const SEARCH_PROVIDER_IDS = [
  "tasks",
  "agents",
  "workflows",
  "schedules",
  "pages",
  "apps",
  "files-name",
  "files-content",
  "skills",
  "mcp-servers",
] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

/** A runtime switch beyond the version and admin gates. */
export type PaletteRequirement = "comb" | "runtime-pools";

/** How a static route appears in the palette's "Go to" group. */
export interface PaletteNav {
  title: string;
  icon: LucideIcon;
  /** The area it lives under ("Settings", "Usage"). Shown muted, and searchable. */
  parent?: string;
  /** More words the search matches. */
  keywords?: string[];
  /** Hidden unless `useIsAdmin()`. Mirrors the sidebar's `adminOnly`. */
  adminOnly?: boolean;
  /** Hidden while the API is older than this. */
  minVersion?: string;
  requires?: PaletteRequirement;
}

export interface RouteHandle {
  /** Listed in "Go to". Required on every static route without `paletteOptOut`. */
  palette?: PaletteNav;
  /** Why the route has no palette entry (a redirect, a flow outside the shell). */
  paletteOptOut?: string;
  /** The providers that search this list's entities. */
  search?: readonly SearchProviderId[];
  /** Why this entity list has no search provider. */
  searchOptOut?: string;
}

/** A route listed in "Go to", searched by `search` providers when given. */
export function nav(
  palette: PaletteNav,
  search?: Pick<RouteHandle, "search" | "searchOptOut">,
): RouteHandle {
  return { palette, ...search };
}

/** A static route deliberately left out of "Go to". */
export function unlisted(
  reason: string,
  search?: Pick<RouteHandle, "search" | "searchOptOut">,
): RouteHandle {
  return { paletteOptOut: reason, ...search };
}

export interface FlatRoute {
  /** Absolute pattern, e.g. `/settings/extensions/:id?`. */
  pattern: string;
  /** The pattern without optional params, or null when it still has a param or splat. */
  staticPath: string | null;
  handle: RouteHandle | undefined;
}

function joinPath(parent: string, path: string): string {
  if (path.startsWith("/")) return path;
  const base = parent.endsWith("/") ? parent : `${parent}/`;
  return `${base}${path}`;
}

function staticPathOf(pattern: string): string | null {
  const segments = pattern.split("/").filter((segment) => !segment.endsWith("?"));
  if (segments.some((segment) => segment.startsWith(":") || segment.includes("*"))) return null;
  return segments.join("/") || "/";
}

/** Every route that renders at a URL, with its absolute pattern. Layout-only routes are skipped. */
export function flattenRoutes(routes: readonly RouteObject[], parent = ""): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const route of routes) {
    const pattern = route.index ? parent || "/" : joinPath(parent, route.path ?? "");
    const isLeaf = route.index || !route.children?.length;
    // A layout route with its own path (`usage`, `settings`) renders through
    // its index child, which carries the handle.
    if (isLeaf) {
      out.push({
        pattern,
        staticPath: staticPathOf(pattern),
        handle: route.handle as RouteHandle | undefined,
      });
    }
    if (route.children) out.push(...flattenRoutes(route.children, pattern));
  }
  return out;
}

/** One "Go to" entry. */
export interface NavEntry extends PaletteNav {
  path: string;
}

/** The palette's "Go to" entries, in route-table order. */
export function navEntries(routes: readonly RouteObject[]): NavEntry[] {
  const out: NavEntry[] = [];
  const seen = new Set<string>();
  for (const route of flattenRoutes(routes)) {
    const palette = route.handle?.palette;
    if (!palette || route.staticPath === null || seen.has(route.staticPath)) continue;
    seen.add(route.staticPath);
    out.push({ ...palette, path: route.staticPath });
  }
  return out;
}

/** Static routes with neither palette metadata nor an opt-out reason. */
export function missingNavMetadata(routes: readonly RouteObject[]): string[] {
  return flattenRoutes(routes)
    .filter((route) => route.staticPath !== null)
    .filter((route) => !route.handle?.palette && !route.handle?.paletteOptOut?.trim())
    .map((route) => route.pattern);
}

/**
 * Entity lists (`/x` with a `/x/:id` sibling) with no search provider and no
 * opt-out reason, plus any handle naming an unknown provider.
 */
export function missingSearchProviders(routes: readonly RouteObject[]): string[] {
  const flat = flattenRoutes(routes);
  const known = new Set<string>(SEARCH_PROVIDER_IDS);
  const problems: string[] = [];
  for (const route of flat) {
    for (const id of route.handle?.search ?? []) {
      if (!known.has(id)) problems.push(`${route.pattern} (unknown provider "${id}")`);
    }
    if (route.staticPath === null) continue;
    const prefix = route.staticPath === "/" ? "/" : `${route.staticPath}/`;
    const isList = flat.some((other) => {
      if (!other.pattern.startsWith(prefix)) return false;
      const rest = other.pattern.slice(prefix.length);
      return /^:[^/]+$/.test(rest);
    });
    if (!isList) continue;
    const handle = route.handle;
    if (!handle?.search?.length && !handle?.searchOptOut?.trim()) problems.push(route.pattern);
  }
  return problems;
}
