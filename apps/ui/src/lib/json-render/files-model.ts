/**
 * Pure helpers behind the `Files` and `File` catalog components (`files.tsx`).
 * Paths follow Comb's drive-path rules (`lib/comb/paths.ts`): absolute, and a
 * folder path ends with "/".
 */

import type { LsEntry } from "../agent-fs/types";
import { childPath } from "../comb/paths";

/** What `Files.onSelect` publishes as `$row`. */
export interface FileRow {
  /** Drive path. A folder's path ends with "/". */
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string | null;
}

/** `"/a/b"`, `"a/b/"` and `"/a//b"` all become `"/a/b/"`; empty is the root. */
export function toFolderPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

/** Folders first, then by name. */
export function fileRows(folder: string, entries: readonly LsEntry[]): FileRow[] {
  return entries
    .map((entry) => ({
      path: childPath(folder, entry.name, entry.type === "directory"),
      name: entry.name,
      type: entry.type,
      size: entry.size,
      modifiedAt: entry.modifiedAt ?? null,
    }))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    );
}

/** True when `path` is `folder` itself or lies inside it. */
function isWithin(folder: string, path: string): boolean {
  return path.startsWith(folder);
}

/**
 * The folder a browser opens on: the folder holding `selectedPath` when it
 * lies under `root` (so a reload or a shared link reopens it), else `root`.
 */
export function initialFolder(root: string, selectedPath: string | undefined): string {
  if (!selectedPath?.startsWith("/")) return root;
  const segments = selectedPath.split("/").filter(Boolean);
  const holder = toFolderPath(segments.slice(0, -1).join("/"));
  return isWithin(root, holder) ? holder : root;
}

/** Crumbs from `root` down to `folder`. `root` is never left. */
export function folderCrumbs(root: string, folder: string): { label: string; path: string }[] {
  const rootName = root.split("/").filter(Boolean).pop() ?? "/";
  const crumbs = [{ label: rootName, path: root }];
  if (!isWithin(root, folder)) return crumbs;
  let path = root;
  for (const segment of folder.slice(root.length).split("/").filter(Boolean)) {
    path = `${path}${segment}/`;
    crumbs.push({ label: segment, path });
  }
  return crumbs;
}
