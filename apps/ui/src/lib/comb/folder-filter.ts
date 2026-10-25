// The folder filter (`?filter=` on a folder page): the folder's own entries
// whose names hold every typed word, plus deeper files from `find` scoped to
// the folder.
//
// Relative imports only: `bun:test` runs this from the repo root.

/** The query param that holds a folder's filter, so a filtered folder is a link and Back keeps it. */
export const FILTER_PARAM = "filter";

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when `name` holds every word of `query` (case-insensitive). An empty query matches. */
export function matchesName(name: string, query: string): boolean {
  const lower = name.toLowerCase();
  return words(query).every((word) => lower.includes(word));
}

export interface NestedMatch {
  /** Comb path ("/docs/a/b.md"). */
  path: string;
  /** The path below the folder ("a/b.md"): the row's name. */
  relative: string;
  size?: number;
  modifiedAt?: string;
}

/**
 * The `find` hits below `folder` that are not its own entries (those are
 * already listed). Best match first, as `find` ranks them.
 */
export function nestedMatches(
  hits: readonly { path: string; size?: number; modifiedAt?: string }[],
  folder: string,
): NestedMatch[] {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return hits.flatMap((hit) => {
    if (!hit.path.startsWith(base)) return [];
    const relative = hit.path.slice(base.length);
    if (!relative.includes("/")) return [];
    return [{ path: hit.path, relative, size: hit.size, modifiedAt: hit.modifiedAt }];
  });
}
