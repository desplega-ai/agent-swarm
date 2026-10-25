// Names for Comb's write actions (New file, New folder, Rename), with the
// rules of the agent-fs live UI (`live/src/lib/paths.ts`). Comb paths start
// with "/" and a folder ends with "/".
//
// Relative imports only: `bun:test` runs this from the repo root.

/** Placeholder written so an empty folder persists and shows up in `ls` (as in the live UI). */
export const KEEP_FILE = ".keep";

/**
 * Clean what the person typed (` sub//dir/name.md `). A nested path is fine.
 * An empty name, or a "." or ".." segment, is an error.
 */
export function normalizeRelativePath(input: string): { path: string } | { error: string } {
  const segments = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return { error: "Enter a name." };
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { error: "Paths cannot contain . or .. segments." };
  }
  return { path: segments.join("/") };
}

/** `relative` inside the Comb folder `folder` ("/docs/" + "a/b.md" = "/docs/a/b.md"). */
export function joinComb(folder: string, relative: string): string {
  const base = folder.replace(/\/+$/, "");
  return `${base}/${relative}`;
}

/** A new file starts with a heading when it is markdown, so it is not empty. Otherwise empty. */
export function starterContent(path: string): string {
  const name = path.split("/").pop() ?? "";
  const markdown = /\.(md|mdx)$/i.exec(name);
  return markdown ? `# ${name.slice(0, -markdown[0].length)}\n` : "";
}

/** The rename box starts with the file's full path, without the leading "/". */
export function renameValue(path: string): string {
  return path.replace(/^\/+/, "");
}
