// The Comb tree rail as a flat list of rows (ARIA tree with `aria-level`), so
// keyboard navigation is index math over one array.

import type { LsEntry } from "../agent-fs/types";
import { ancestorFolders, childPath } from "./paths";

/** Folders first, then files, each in natural name order ("a2" before "a10"). */
export function sortEntries(entries: readonly LsEntry[]): LsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** A loaded listing, or why a folder has none yet. */
export type FolderListing = readonly LsEntry[] | "loading" | "error";

export type TreeRow =
  | {
      kind: "entry";
      path: string;
      name: string;
      isFolder: boolean;
      level: number;
      posinset: number;
      setsize: number;
    }
  | {
      kind: "status";
      key: string;
      /** The folder whose listing this row reports on. */
      folder: string;
      level: number;
      status: "loading" | "error" | "empty";
    };

/** Folders whose listing the tree shows: the root plus each open folder with open ancestors. */
export function visibleFolders(expanded: ReadonlySet<string>): string[] {
  const open = [...expanded].filter((folder) =>
    ancestorFolders(folder).every((a) => a === "/" || expanded.has(a)),
  );
  return ["/", ...open.filter((folder) => folder !== "/")];
}

/** The visible rows, top to bottom. An open folder's children follow it one level deeper. */
export function flattenTree(
  listing: (folder: string) => FolderListing,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (folder: string, level: number) => {
    const result = listing(folder);
    if (result === "loading" || result === "error") {
      rows.push({ kind: "status", key: `${folder}:${result}`, folder, level, status: result });
      return;
    }
    if (result.length === 0) {
      if (folder !== "/")
        rows.push({ kind: "status", key: `${folder}:empty`, folder, level, status: "empty" });
      return;
    }
    const sorted = sortEntries(result);
    sorted.forEach((entry, index) => {
      const isFolder = entry.type === "directory";
      const path = childPath(folder, entry.name, isFolder);
      rows.push({
        kind: "entry",
        path,
        name: entry.name,
        isFolder,
        level,
        posinset: index + 1,
        setsize: sorted.length,
      });
      if (isFolder && expanded.has(path)) walk(path, level + 1);
    });
  };
  walk("/", 1);
  return rows;
}
