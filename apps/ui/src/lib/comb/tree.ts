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

/**
 * The tree of a filter: the matched files (Comb paths) under the folders that
 * hold them, every folder open. Sorted like the drive tree. Matches past the
 * `find` limit are not here: the caller says so.
 */
export function matchTree(paths: readonly string[]): TreeRow[] {
  interface Node {
    folders: Map<string, Node>;
    files: Set<string>;
  }
  const root: Node = { folders: new Map(), files: new Set() };
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    const name = segments.pop();
    if (!name) continue;
    let node = root;
    for (const segment of segments) {
      let next = node.folders.get(segment);
      if (!next) {
        next = { folders: new Map(), files: new Set() };
        node.folders.set(segment, next);
      }
      node = next;
    }
    node.files.add(name);
  }
  const rows: TreeRow[] = [];
  const walk = (node: Node, folder: string, level: number) => {
    const entries = sortEntries([
      ...[...node.folders.keys()].map((name): LsEntry => ({ name, type: "directory", size: 0 })),
      ...[...node.files].map((name): LsEntry => ({ name, type: "file", size: 0 })),
    ]);
    entries.forEach((entry, index) => {
      const isFolder = entry.type === "directory";
      const path = childPath(folder, entry.name, isFolder);
      rows.push({
        kind: "entry",
        path,
        name: entry.name,
        isFolder,
        level,
        posinset: index + 1,
        setsize: entries.length,
      });
      const child = node.folders.get(entry.name);
      if (isFolder && child) walk(child, path, level + 1);
    });
  };
  walk(root, "/", 1);
  return rows;
}

/** A name split into plain and matched parts: each query word, case-insensitive, is marked. */
export function nameParts(name: string, query: string): { text: string; hit: boolean }[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (words.length === 0) return [{ text: name, hit: false }];
  const lower = name.toLowerCase();
  const marked = new Array<boolean>(name.length).fill(false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
      marked.fill(true, at, at + word.length);
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < name.length; index++) {
    const last = parts[parts.length - 1];
    const hit = marked[index] as boolean;
    if (last && last.hit === hit) last.text += name[index];
    else parts.push({ text: name[index] as string, hit });
  }
  return parts;
}
