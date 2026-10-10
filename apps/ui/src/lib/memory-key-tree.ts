// Folder tree over memory key paths ("/longterm/facts/swarm-deploy/x") for
// the /memory longterm view. Folders are the path segments; each memory is a
// leaf in the folder of its last segment. A key can be a leaf and a folder
// prefix at once ("/a/b" and "/a/b/c"): both show.

export interface KeyLeaf<T> {
  /** Last path segment of the key. */
  name: string;
  item: T;
}

export interface KeyFolder<T> {
  /** Full prefix with a trailing slash, e.g. "/longterm/facts/". */
  path: string;
  /** Last segment, e.g. "facts". The root's name is its path. */
  name: string;
  folders: KeyFolder<T>[];
  leaves: KeyLeaf<T>[];
  /** Memories in this folder and every folder below it. */
  count: number;
}

/** Normalize a prefix to start and end with "/". */
export function normalizeFolderPath(path: string): string {
  let out = path.startsWith("/") ? path : `/${path}`;
  if (!out.endsWith("/")) out = `${out}/`;
  return out;
}

export function buildKeyTree<T extends { key: string }>(
  items: readonly T[],
  rootPath: string,
): KeyFolder<T> {
  const root: KeyFolder<T> = {
    path: normalizeFolderPath(rootPath),
    name: normalizeFolderPath(rootPath),
    folders: [],
    leaves: [],
    count: 0,
  };
  const byPath = new Map<string, KeyFolder<T>>([[root.path, root]]);

  for (const item of items) {
    if (!item.key.startsWith(root.path)) continue;
    const segments = item.key.slice(root.path.length).split("/").filter(Boolean);
    const leafName = segments.pop();
    if (!leafName) continue;
    let folder = root;
    folder.count++;
    for (const segment of segments) {
      const path = `${folder.path}${segment}/`;
      let child = byPath.get(path);
      if (!child) {
        child = { path, name: segment, folders: [], leaves: [], count: 0 };
        byPath.set(path, child);
        folder.folders.push(child);
      }
      child.count++;
      folder = child;
    }
    folder.leaves.push({ name: leafName, item });
  }

  const sort = (folder: KeyFolder<T>) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.leaves.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** The folder paths from the root down to `path` (inclusive), for auto-expanding. */
export function ancestorFolderPaths(rootPath: string, path: string): string[] {
  const root = normalizeFolderPath(rootPath);
  const target = normalizeFolderPath(path);
  if (!target.startsWith(root)) return [root];
  const out = [root];
  let current = root;
  for (const segment of target.slice(root.length).split("/").filter(Boolean)) {
    current = `${current}${segment}/`;
    out.push(current);
  }
  return out;
}
